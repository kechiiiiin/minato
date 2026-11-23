// HTTP の口（Hono）。港は画面を持たず、API だけ。テストから時計と fetch を差し替えられるよう createApp で作る
import { Hono, type Context } from "hono";
import { requireAccess } from "./auth.ts";
import { runCollect, type CollectDeps } from "./collect.ts";
import { isDate, jstDate } from "./dates.ts";
import type { AppEnv } from "./env.ts";
import { parseIngest } from "./ingest.ts";
import { sourceLabel } from "./sources/index.ts";
import { insertLog, latestLog, listMaterials, upsertMaterials, type LogRow, type MaterialView } from "./store.ts";

export const defaultDeps: CollectDeps = {
  now: () => new Date(),
  fetch: (input, init) => fetch(input, init),
};

type C = Context<AppEnv>;

async function jsonBody(c: C): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function createApp(deps: CollectDeps = defaultDeps) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
  });
  // 港の口は全部 Access の裏（画面は無いので、/api の外は 404 を返すだけ）
  app.use("*", requireAccess);

  /** その日の材料を、出どころごとにまとめて。status は出どころごとの最後の集め */
  app.get("/api/materials", async (c) => {
    const date = c.req.query("date") ?? "";
    if (!isDate(date)) return c.json({ error: "bad_date" }, 400);
    const [rows, status] = await Promise.all([listMaterials(c.env.DB, date), latestLog(c.env.DB, date)]);
    const groups = new Map<string, MaterialView[]>();
    for (const r of rows) groups.set(r.source, [...(groups.get(r.source) ?? []), r]);
    return c.json({
      date,
      groups: [...groups.entries()].map(([source, items]) => ({ source, label: sourceLabel(source), count: items.length, items })),
      status: status.map((s) => ({ ...s, label: sourceLabel(s.source) })),
    });
  });

  /** 今すぐ集める。本文かクエリの date（省略時は JST の今日） */
  app.post("/api/collect", async (c) => {
    const b = await jsonBody(c);
    const fromBody = b && typeof b === "object" && !Array.isArray(b) ? (b as { date?: unknown }).date : undefined;
    const raw = fromBody ?? c.req.query("date");
    const date = raw === undefined || raw === null || raw === "" ? jstDate(deps.now()) : raw;
    if (!isDate(date)) return c.json({ error: "bad_date" }, 400);
    const report = await runCollect(c.env, deps, [date], "manual");
    return c.json({ date, ...report, results: report.results.map((r) => ({ ...r, label: sourceLabel(r.source) })) });
  });

  /** Mac から配列で upsert（vault の log・Ambient Context） */
  app.post("/api/ingest", async (c) => {
    const parsed = parseIngest(await jsonBody(c));
    if (!parsed.ok) return c.json({ error: parsed.error, ...(parsed.index !== undefined ? { index: parsed.index } : {}) }, 400);
    const now = deps.now();
    await upsertMaterials(c.env.DB, parsed.items, now, parsed.replace);
    // 記録は (source, date) ごとに1行
    const counts = new Map<string, LogRow>();
    for (const r of parsed.replace) counts.set(`${r.source}|${r.date}`, { source: r.source, date: r.date, status: "ok", count: 0, reason: null });
    for (const m of parsed.items) {
      const k = `${m.source}|${m.date}`;
      const row: LogRow = counts.get(k) ?? { source: m.source, date: m.date, status: "ok", count: 0, reason: null };
      row.count++;
      counts.set(k, row);
    }
    await insertLog(c.env.DB, now, "ingest", [...counts.values()]);
    return c.json({ accepted: parsed.items.length, replaced: parsed.replace });
  });

  app.all("*", (c) => c.json({ error: "not_found" }, 404));

  app.onError((err, c) => {
    console.log(JSON.stringify({ event: "unhandled", name: err.name, message: String(err.message).slice(0, 200) }));
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
