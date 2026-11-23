// Mac からの受け取り: 配列で冪等 upsert・受けるのは vault-log / ambient だけ・replace で入れ替え
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.ts";

const D = "2026-11-23";
const item = (o: Record<string, unknown> = {}) => ({ source: "vault-log", external_id: "h1", date: D, title: "暮らし | カード利用チェック", ...o });

test("upsert は冪等（同じものを2回送っても1行・中身は後勝ち）", async () => {
  const s = setup();
  let r = await s.call("POST", "/api/ingest", { items: [item(), item({ external_id: "h2", occurred_at: "2026-11-23T01:00:00Z" })] });
  assert.equal(r.status, 200);
  assert.equal(r.json.accepted, 2);
  r = await s.call("POST", "/api/ingest", { items: [item({ detail: { body: "直した" } })] });
  assert.equal(s.count("SELECT COUNT(*) AS n FROM materials"), 2);
  const m = await s.call("GET", `/api/materials?date=${D}`);
  const g = m.json.groups[0];
  assert.equal(g.source, "vault-log");
  assert.equal(g.label, "ヘスティアとのやりとり（vault の log）");
  // 時刻のあるものが先、無いものは後ろ
  assert.deepEqual(g.items.map((i: any) => [i.external_id, i.occurred_at]), [
    ["h2", "2026-11-23T10:00:00+09:00"],
    ["h1", null],
  ]);
  assert.deepEqual(g.items[1].detail, { body: "直した" });
  assert.equal(s.count("SELECT COUNT(*) AS n FROM collect_log WHERE trigger = 'ingest' AND source = 'vault-log' AND count = 2"), 1);
});

test("replace: 送ったものがその日の全部。送らなかった古い行は消える（ほかの日は残る）", async () => {
  const s = setup();
  await s.call("POST", "/api/ingest", { items: [item(), item({ external_id: "h2" }), item({ external_id: "old", date: "2026-11-22" })] });
  s.clock.set("2026-11-23T04:00:00Z");
  const r = await s.call("POST", "/api/ingest", { items: [item({ external_id: "h2" })], replace: [{ source: "vault-log", date: D }] });
  assert.deepEqual(r.json.replaced, [{ source: "vault-log", date: D }]);
  assert.deepEqual(s.raw.prepare("SELECT external_id FROM materials ORDER BY external_id").all().map((x: any) => x.external_id), ["h2", "old"]);
  // 0 件で replace ＝ その日を空にする
  s.clock.set("2026-11-23T05:00:00Z");
  await s.call("POST", "/api/ingest", { items: [], replace: [{ source: "vault-log", date: D }] });
  assert.equal(s.count("SELECT COUNT(*) AS n FROM materials WHERE date = ?", D), 0);
});

test("cron の出どころ名・知らない出どころは受けない（上書きさせない）", async () => {
  const s = setup();
  for (const src of ["tayori", "nobu", "weather", "unknown", "toString", "__proto__"]) {
    const r = await s.call("POST", "/api/ingest", { items: [item({ source: src })] });
    assert.equal(r.status, 400, src);
    assert.equal(r.json.error, "bad_source");
  }
  assert.equal((await s.call("POST", "/api/ingest", { items: [], replace: [{ source: "tayori", date: D }] })).json.error, "bad_replace");
  assert.equal(s.count("SELECT COUNT(*) AS n FROM materials"), 0);
});

test("形の検査: 1件でも不正なら全部入れない", async () => {
  const s = setup();
  const bad: [unknown, string][] = [
    [{}, "items_required"],
    [{ items: "x" }, "items_required"],
    [{ items: [item(), item({ date: "2026-11-31" })] }, "bad_date"],
    [{ items: [item({ occurred_at: "2026-11-23T10:00:00" })] }, "bad_occurred_at"],
    [{ items: [item({ title: "  " })] }, "bad_title"],
    [{ items: [item({ external_id: "" })] }, "bad_external_id"],
    [{ items: [item({ url: "javascript:alert(1)" })] }, "bad_url"],
    [{ items: [item({ detail: [1, 2] })] }, "bad_detail"],
    [{ items: [item({ detail: { s: "x".repeat(70000) } })] }, "detail_too_large"],
    [{ items: Array.from({ length: 501 }, (_, i) => item({ external_id: `e${i}` })) }, "too_many_items"],
  ];
  for (const [b, err] of bad) {
    const r = await s.call("POST", "/api/ingest", b);
    assert.equal(r.status, 400, err);
    assert.equal(r.json.error, err);
  }
  assert.equal(s.count("SELECT COUNT(*) AS n FROM materials"), 0);
  const ok = await s.call("POST", "/api/ingest", { items: [item({ source: "ambient", url: "obsidian://open?vault=x" })] });
  assert.equal(ok.status, 200);
});

test("materials: 日付が不正なら 400・無い日は空", async () => {
  const s = setup();
  assert.equal((await s.call("GET", "/api/materials")).status, 400);
  assert.equal((await s.call("GET", "/api/materials?date=2026-13-01")).status, 400);
  const r = await s.call("GET", `/api/materials?date=${D}`);
  assert.deepEqual(r.json, { date: D, groups: [], status: [] });
});
