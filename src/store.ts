// D1 の読み書き。材料は (source, external_id) で冪等に upsert する

/** 入れる材料1件（出どころのモジュールと Mac からの受け取りが作る） */
export interface MaterialInput {
  source: string;
  external_id: string;
  /** +09:00 付きの ISO8601。時刻の無いもの（日単位）は null */
  occurred_at: string | null;
  /** JST の YYYY-MM-DD */
  date: string;
  title: string;
  url: string | null;
  detail: Record<string, unknown>;
}

/** 返す材料1件 */
export interface MaterialView {
  id: number;
  source: string;
  external_id: string;
  occurred_at: string | null;
  date: string;
  title: string;
  url: string | null;
  detail: Record<string, unknown>;
  collected_at: string;
}

export type CollectStatus = "ok" | "skipped" | "error";

/** 集めた記録の1行 */
export interface LogRow {
  source: string;
  date: string;
  status: CollectStatus;
  count: number;
  reason: string | null;
}

const UPSERT_SQL = `INSERT INTO materials (source, external_id, occurred_at, date, title, url, detail, collected_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (source, external_id) DO UPDATE SET
  occurred_at = excluded.occurred_at,
  date = excluded.date,
  title = excluded.title,
  url = excluded.url,
  detail = excluded.detail,
  collected_at = excluded.collected_at`;

/**
 * 材料を upsert する（1つの batch＝1つのトランザクション）。
 * replace に挙げた (source, date) は「今回入れたものが全部」とみなし、今回入れなかった古い行を消す
 * （既読を戻した記事・消した記録が港に残らないように）。見分けは collected_at が今回の時刻か。
 */
export async function upsertMaterials(
  db: D1Database,
  items: MaterialInput[],
  now: Date,
  replace: { source: string; date: string }[] = [],
): Promise<number> {
  const at = now.toISOString();
  const stmts: D1PreparedStatement[] = items.map((m) =>
    db.prepare(UPSERT_SQL).bind(m.source, m.external_id, m.occurred_at, m.date, m.title, m.url, JSON.stringify(m.detail ?? {}), at),
  );
  for (const r of replace) {
    stmts.push(db.prepare("DELETE FROM materials WHERE source = ? AND date = ? AND collected_at <> ?").bind(r.source, r.date, at));
  }
  if (stmts.length > 0) await db.batch(stmts);
  return items.length;
}

interface MaterialRow extends Omit<MaterialView, "detail"> {
  detail: string;
}

function parseDetail(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** その日の材料（出どころ順・時刻順。時刻の無いものは出どころの中で後ろ） */
export async function listMaterials(db: D1Database, date: string): Promise<MaterialView[]> {
  const rows = (
    await db
      .prepare(
        `SELECT id, source, external_id, occurred_at, date, title, url, detail, collected_at FROM materials
          WHERE date = ? ORDER BY source, occurred_at IS NULL, occurred_at, id LIMIT 2000`,
      )
      .bind(date)
      .all<MaterialRow>()
  ).results;
  return rows.map((r) => ({ ...r, detail: parseDetail(r.detail) }));
}

/** 集めた記録を残す */
export async function insertLog(db: D1Database, runAt: Date, trigger: "cron" | "manual" | "ingest", rows: LogRow[]): Promise<void> {
  if (rows.length === 0) return;
  const at = runAt.toISOString();
  await db.batch(
    rows.map((r) =>
      db
        .prepare("INSERT INTO collect_log (run_at, trigger, date, source, status, count, reason) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(at, trigger, r.date, r.source, r.status, r.count, r.reason),
    ),
  );
}

/** その日の分について、出どころごとの最後の記録 */
export async function latestLog(
  db: D1Database,
  date: string,
): Promise<{ source: string; status: CollectStatus; count: number; reason: string | null; run_at: string; trigger: string }[]> {
  return (
    await db
      .prepare(
        `SELECT l.source, l.status, l.count, l.reason, l.run_at, l.trigger FROM collect_log l
          WHERE l.date = ?1 AND l.id = (SELECT MAX(id) FROM collect_log x WHERE x.date = ?1 AND x.source = l.source)
          ORDER BY l.source`,
      )
      .bind(date)
      .all<{ source: string; status: CollectStatus; count: number; reason: string | null; run_at: string; trigger: string }>()
  ).results;
}

/** 集めた記録は 30 日で消す（材料は消さない） */
export const LOG_KEEP_DAYS = 30;

export async function pruneLog(db: D1Database, now: Date): Promise<void> {
  const cut = new Date(now.getTime() - LOG_KEEP_DAYS * 86400_000).toISOString();
  await db.prepare("DELETE FROM collect_log WHERE run_at < ?").bind(cut).run();
}
