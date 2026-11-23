// 集める係。出どころを順に回し、ok は upsert（その日のその出どころは「今回のが全部」として入れ替え）、
// skipped・error は理由を collect_log に残す。1つの出どころの失敗で他を止めない
import { SOURCES } from "./sources/index.ts";
import { UpstreamError, type Fetcher, type Source } from "./sources/types.ts";
import type { Env } from "./env.ts";
import { insertLog, upsertMaterials, type LogRow } from "./store.ts";

export interface CollectDeps {
  now: () => Date;
  fetch: Fetcher;
  /** テストで差し替える */
  sources?: Source[];
}

export interface CollectReport {
  run_at: string;
  trigger: "cron" | "manual";
  results: LogRow[];
}

function reasonOf(e: unknown): string {
  // 自分で作った UpstreamError の文言だけ載せる（想定外の例外の文言に秘密や URL が混ざらないように）
  if (e instanceof UpstreamError) return e.message.slice(0, 300);
  return `想定外の失敗（${e instanceof Error ? e.name : "error"}）`;
}

export async function runCollect(env: Env, deps: CollectDeps, dates: string[], trigger: "cron" | "manual"): Promise<CollectReport> {
  const now = deps.now();
  const sources = deps.sources ?? SOURCES;
  const results: LogRow[] = [];
  for (const date of dates) {
    for (const s of sources) {
      try {
        const r = await s.collect(date, { env, fetch: deps.fetch, now });
        if (r.status === "skipped") {
          results.push({ source: s.name, date, status: "skipped", count: 0, reason: r.reason });
          continue;
        }
        const n = await upsertMaterials(env.DB, r.items, now, [{ source: s.name, date }]);
        results.push({ source: s.name, date, status: "ok", count: n, reason: null });
      } catch (e) {
        console.warn(JSON.stringify({ event: "collect_error", source: s.name, date, reason: reasonOf(e) }));
        results.push({ source: s.name, date, status: "error", count: 0, reason: reasonOf(e) });
      }
    }
  }
  await insertLog(env.DB, now, trigger, results);
  return { run_at: now.toISOString(), trigger, results };
}
