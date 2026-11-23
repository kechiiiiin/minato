// 集める係: secret 無しは黙ってスキップ（理由を残す）・各出どころの読み替え・冪等 upsert・失敗しても他を止めない
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_SOURCES_ENV, setup, type MockWeb } from "./helpers.ts";

const D = "2026-11-23";

function routeAll(web: MockWeb, date = D) {
  web.set(`https://tayori.example/api/items/read-on?date=${date}`, {
    json: {
      items: [
        { id: 7, feed_title: "アニクマ", title: "記事 A", url: "https://a.example/1", published_at: null, read_at: "2026-11-22T15:00:00.000Z", comment: null },
        { id: 9, feed_title: "アニクマ", title: "記事 B", url: null, published_at: null, read_at: "2026-11-23T14:59:59.999Z", comment: "あとで" },
      ],
    },
  });
  web.set("https://nobu.example/api/timeline?limit=100", {
    json: {
      items: [
        { kind: "status", cursor: "2026-11-24T08:00:00#e000000000012", day: "2026-11-24", event_id: 12, at: "2026-11-23T23:00:00.000Z", from_status: null, to_status: "want", book: { id: 3, title: "明日の本", cover_url: null } },
        { kind: "status", cursor: "2026-11-23T21:00:00#e000000000011", day: D, event_id: 11, at: "2026-11-23T12:00:00.000Z", from_status: "reading", to_status: "read", book: { id: 2, title: "本 B", cover_url: null } },
        { kind: "read", cursor: "2026-11-23T00:00:00#d", day: D, books: [{ id: 1, title: "本 A", cover_url: "https://img.example/a.jpg" }] },
      ],
      next: "2026-11-23T00:00:00#d",
    },
  });
  web.set("https://nobu.example/api/timeline?limit=100&before=2026-11-23T00%3A00%3A00%23d", {
    json: { items: [{ kind: "read", cursor: "2026-11-22T00:00:00#d", day: "2026-11-22", books: [{ id: 9, title: "昨日の本", cover_url: null }] }], next: null },
  });
  web.set(`https://health.example/v1/app/day/${date}`, {
    json: {
      date,
      metrics: [
        { metric: "steps", label: "歩数", unit: "歩", decimals: 0, status: "ok", value: 8123, avg: null, min: null, max: null, seconds: null },
        { metric: "heart_rate", label: "心拍数", unit: "bpm", decimals: 0, status: "no_data", value: null, avg: null, min: null, max: null, seconds: null },
      ],
      sleep: null,
    },
  });
  web.set(`https://health.example/v1/app/meals?from=${date}&to=${date}`, {
    json: { from: date, to: date, days: [{ date, meals: [{ id: "m1", slot: "lunch", eaten_at: null, items: "そば", kcal: 400, p: 15, f: 5, c: 70 }], total: null, note: null }] },
  });
  web.set("https://api.hevyapp.com/v1/workouts?page=1&pageSize=10", {
    json: {
      page: 1,
      page_count: 1,
      workouts: [
        { id: "w2", title: "Day A", start_time: "2026-11-23T10:00:00Z", end_time: "2026-11-23T11:00:00Z", exercises: [{ title: "スクワット", sets: [{ type: "normal", weight_kg: 40, reps: 10 }] }] },
        { id: "w1", title: "Day B", start_time: "2026-11-22T10:00:00Z", end_time: "2026-11-22T11:00:00Z", exercises: [] },
      ],
    },
  });
  web.set(
    `https://api.open-meteo.com/v1/forecast?latitude=35&longitude=139&daily=weather_code%2Ctemperature_2m_max%2Ctemperature_2m_min%2Cprecipitation_sum&timezone=Asia%2FTokyo&start_date=${date}&end_date=${date}`,
    { json: { daily: { time: [date], weather_code: [61], temperature_2m_max: [12.5], temperature_2m_min: [7.8], precipitation_sum: [3.2] } } },
  );
}

test("secret・設定が無い出どころは外へ出ずにスキップし、理由を返して記録に残す", async () => {
  const s = setup();
  const r = await s.call("POST", "/api/collect", { date: D });
  assert.equal(r.status, 200);
  assert.equal(s.web.calls.length, 0);
  const by = Object.fromEntries(r.json.results.map((x: any) => [x.source, x]));
  assert.deepEqual(Object.keys(by).sort(), ["health", "hevy", "nobu", "tayori", "weather"]);
  for (const x of r.json.results) assert.equal(x.status, "skipped", x.source);
  assert.equal(by.tayori.reason, "TAYORI_URL / TAYORI_CLIENT_ID / TAYORI_CLIENT_SECRET が未設定");
  assert.equal(by.hevy.reason, "HEVY_API_KEY が未設定");
  assert.equal(by.weather.reason, "WEATHER_LATITUDE / WEATHER_LONGITUDE が未設定");
  assert.equal(s.count("SELECT COUNT(*) AS n FROM collect_log WHERE status = 'skipped' AND trigger = 'manual'"), 5);
  assert.equal(s.count("SELECT COUNT(*) AS n FROM materials"), 0);
});

test("一部だけ設定があれば、そこだけ集める（秘密が片方だけでもスキップ）", async () => {
  const s = setup({ env: { TAYORI_URL: "https://tayori.example", TAYORI_CLIENT_ID: "tayori-id", HEVY_API_KEY: " " } });
  const r = await s.call("POST", "/api/collect", { date: D });
  const by = Object.fromEntries(r.json.results.map((x: any) => [x.source, x]));
  assert.equal(by.tayori.reason, "TAYORI_CLIENT_SECRET が未設定");
  assert.equal(by.hevy.status, "skipped");
  assert.equal(s.web.calls.length, 0);
});

test("全部そろえば集まり、/api/materials が出どころごとに返す", async () => {
  const s = setup({ env: ALL_SOURCES_ENV });
  routeAll(s.web);
  const r = await s.call("POST", "/api/collect", { date: D });
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.json.results.map((x: any) => [x.source, x]));
  assert.deepEqual(
    Object.fromEntries(Object.entries(by).map(([k, v]: [string, any]) => [k, [v.status, v.count]])),
    { tayori: ["ok", 2], nobu: ["ok", 2], health: ["ok", 2], hevy: ["ok", 1], weather: ["ok", 1] },
  );

  // 上流へはサービストークンのヘッダを付け、リダイレクトは追わない
  const t = s.web.calls.find((c) => c.url.startsWith("https://tayori.example"))!;
  assert.equal(t.headers["cf-access-client-id"], "tayori-id");
  assert.equal(t.headers["cf-access-client-secret"], "tayori-secret");
  assert.equal(t.redirect, "manual");
  assert.equal(s.web.calls.find((c) => c.url.startsWith("https://api.hevyapp.com"))!.headers["api-key"], "hevy-key");
  const meteo = s.web.calls.find((c) => c.url.startsWith("https://api.open-meteo.com"))!;
  assert.equal(meteo.headers["cf-access-client-id"], undefined);

  const m = await s.call("GET", `/api/materials?date=${D}`);
  assert.equal(m.status, 200);
  const g = Object.fromEntries(m.json.groups.map((x: any) => [x.source, x]));
  assert.deepEqual(Object.keys(g).sort(), ["health", "hevy", "nobu", "tayori", "weather"]);
  assert.equal(g.tayori.label, "便りで読んだ記事");
  assert.deepEqual(
    g.tayori.items.map((i: any) => [i.external_id, i.occurred_at, i.date]),
    [
      ["item:7", "2026-11-23T00:00:00+09:00", D],
      ["item:9", "2026-11-23T23:59:59+09:00", D],
    ],
  );
  assert.equal(g.tayori.items[1].detail.comment, "あとで");
  assert.deepEqual(
    g.nobu.items.map((i: any) => [i.external_id, i.title]),
    [
      ["event:11", "読了: 本 B"],
      ["read:2026-11-23:1", "読んだ: 本 A"],
    ],
  );
  assert.equal(g.health.items.find((i: any) => i.external_id === `day:${D}`).title, "からだ帳: 歩数 8,123歩");
  assert.equal(g.health.items.find((i: any) => i.external_id === "meal:m1").title, "昼食: そば");
  assert.deepEqual(g.health.items.find((i: any) => i.external_id === `day:${D}`).detail.metrics.map((x: any) => x.metric), ["steps"]);
  assert.deepEqual(g.hevy.items.map((i: any) => [i.external_id, i.occurred_at]), [["workout:w2", "2026-11-23T19:00:00+09:00"]]);
  assert.equal(g.weather.items[0].title, "小雨・最高 12.5℃／最低 7.8℃・降水 3.2mm");
  assert.equal(JSON.stringify(g.weather.items[0].detail).includes("35"), false, "座標を材料に入れない");
  assert.deepEqual(m.json.status.map((x: any) => [x.source, x.status, x.count]).sort(), [
    ["health", "ok", 2],
    ["hevy", "ok", 1],
    ["nobu", "ok", 2],
    ["tayori", "ok", 2],
    ["weather", "ok", 1],
  ]);
});

test("冪等: 同じ日を何度集めても行は増えず、上流で消えたものは港からも消える", async () => {
  const s = setup({ env: ALL_SOURCES_ENV });
  routeAll(s.web);
  await s.call("POST", "/api/collect", { date: D });
  const n1 = s.count("SELECT COUNT(*) AS n FROM materials");
  assert.equal(n1, 8);
  s.clock.set("2026-11-23T04:00:00Z");
  await s.call("POST", "/api/collect", { date: D });
  assert.equal(s.count("SELECT COUNT(*) AS n FROM materials"), n1);
  assert.equal(s.count("SELECT COUNT(*) AS n FROM materials WHERE collected_at = '2026-11-23T04:00:00.000Z'"), n1);

  // 便りで既読を戻した（read-on から消えた）→ 次の集めで港からも消える。題名の変化は上書き
  s.web.set(`https://tayori.example/api/items/read-on?date=${D}`, {
    json: { items: [{ id: 7, feed_title: "アニクマ", title: "記事 A（改題）", url: null, published_at: null, read_at: "2026-11-22T15:00:00.000Z", comment: null }] },
  });
  s.clock.set("2026-11-23T05:00:00Z");
  await s.call("POST", "/api/collect", { date: D });
  const rows = s.raw.prepare("SELECT external_id, title FROM materials WHERE source = 'tayori'").all();
  assert.deepEqual(rows.map((r: any) => [r.external_id, r.title]), [["item:7", "記事 A（改題）"]]);
  // ほかの日の同じ出どころには触らない
});

test("入れ替えはその日のその出どころだけ（ほかの日・ほかの出どころは残る）", async () => {
  const s = setup({ env: { TAYORI_URL: "https://tayori.example", TAYORI_CLIENT_ID: "i", TAYORI_CLIENT_SECRET: "s" } });
  s.web.set("https://tayori.example/api/items/read-on?date=2026-11-22", {
    json: { items: [{ id: 1, feed_title: "x", title: "前の日", url: null, published_at: null, read_at: "2026-11-22T01:00:00Z", comment: null }] },
  });
  s.web.set(`https://tayori.example/api/items/read-on?date=${D}`, { json: { items: [] } });
  await s.call("POST", "/api/collect", { date: "2026-11-22" });
  await s.call("POST", "/api/ingest", { items: [{ source: "vault-log", external_id: "a", date: D, title: "log" }] });
  await s.call("POST", "/api/collect", { date: D });
  assert.equal(s.count("SELECT COUNT(*) AS n FROM materials WHERE date = '2026-11-22' AND source = 'tayori'"), 1);
  assert.equal(s.count("SELECT COUNT(*) AS n FROM materials WHERE source = 'vault-log'"), 1);
});

test("1つの出どころが失敗しても他は集まり、失敗は理由つきで残る（前の材料は消さない）", async () => {
  const s = setup({ env: ALL_SOURCES_ENV });
  routeAll(s.web);
  await s.call("POST", "/api/collect", { date: D });
  s.web.set(`https://tayori.example/api/items/read-on?date=${D}`, { status: 302, body: "", headers: { Location: "https://login.example/" } });
  s.web.set("https://api.hevyapp.com/v1/workouts?page=1&pageSize=10", { throws: true });
  s.web.set(`https://health.example/v1/app/meals?from=${D}&to=${D}`, { status: 500, body: "boom" });
  const r = await s.call("POST", "/api/collect", { date: D });
  const by = Object.fromEntries(r.json.results.map((x: any) => [x.source, x]));
  assert.equal(by.tayori.status, "error");
  assert.match(by.tayori.reason, /HTTP 302/);
  assert.equal(by.hevy.status, "error");
  assert.match(by.hevy.reason, /通信できない/);
  assert.equal(by.health.reason, "HTTP 500");
  assert.equal(by.nobu.status, "ok");
  assert.equal(by.weather.status, "ok");
  assert.equal(s.count("SELECT COUNT(*) AS n FROM materials WHERE source = 'tayori'"), 2, "失敗した出どころの前の材料は残す");
  for (const x of r.json.results) assert.equal(String(x.reason ?? "").includes("secret"), false);
});

test("からだ帳: その日の記録が無い（404）なら日の行は作らず、食事だけ", async () => {
  const s = setup({ env: { HEALTH_URL: "https://health.example", HEALTH_CLIENT_ID: "i", HEALTH_CLIENT_SECRET: "s" } });
  s.web.set(`https://health.example/v1/app/meals?from=${D}&to=${D}`, { json: { days: [{ date: D, meals: [], total: null, note: "眠い" }] } });
  const r = await s.call("POST", "/api/collect", { date: D });
  assert.deepEqual([r.json.results[2].source, r.json.results[2].status, r.json.results[2].count], ["health", "ok", 1]);
});

test("天気: 座標が数でなければスキップ、未来の日もスキップ", async () => {
  let s = setup({ env: { WEATHER_LATITUDE: "north", WEATHER_LONGITUDE: "139" } });
  let r = await s.call("POST", "/api/collect", { date: D });
  assert.equal(r.json.results.find((x: any) => x.source === "weather").reason, "WEATHER_LATITUDE / WEATHER_LONGITUDE が数として読めない");
  s = setup({ env: { WEATHER_LATITUDE: "35", WEATHER_LONGITUDE: "139" } });
  r = await s.call("POST", "/api/collect", { date: "2026-11-25" });
  assert.equal(r.json.results.find((x: any) => x.source === "weather").reason, "未来の日");
  assert.equal(s.web.calls.length, 0);
});

test("手動の collect: date 省略は JST の今日・不正は 400", async () => {
  const s = setup({ now: "2026-11-23T15:30:00Z" }); // JST 11/24 0:30
  const r = await s.call("POST", "/api/collect");
  assert.equal(r.status, 200);
  assert.equal(r.json.date, "2026-11-24");
  assert.equal(r.json.trigger, "manual");
  assert.equal((await s.call("POST", "/api/collect", { date: "2026-02-30" })).status, 400);
  assert.equal((await s.call("POST", "/api/collect?date=2026-11-20")).json.date, "2026-11-20");
});

test("cron と同じ流れ: JST 0時台は前日と当日の両方を集め、記録は trigger=cron", async () => {
  const { runCollect } = await import("../src/collect.ts");
  const { datesToCollect } = await import("../src/dates.ts");
  const s = setup({ now: "2026-11-23T15:05:00Z", env: { TAYORI_URL: "https://tayori.example", TAYORI_CLIENT_ID: "i", TAYORI_CLIENT_SECRET: "s" } });
  s.web.set("https://tayori.example/api/items/read-on?date=2026-11-23", { json: { items: [] } });
  s.web.set("https://tayori.example/api/items/read-on?date=2026-11-24", { json: { items: [] } });
  const r = await runCollect(s.env, s.deps, datesToCollect(s.clock.now()), "cron");
  assert.deepEqual(
    r.results.filter((x) => x.source === "tayori").map((x) => [x.date, x.status]),
    [
      ["2026-11-23", "ok"],
      ["2026-11-24", "ok"],
    ],
  );
  assert.equal(s.count("SELECT COUNT(*) AS n FROM collect_log WHERE trigger = 'cron'"), 10);
});
