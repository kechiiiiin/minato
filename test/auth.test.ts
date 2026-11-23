// 認証: allowlist 内は通る／外は 403／未設定は通さない。拒んだ要求では書き込まず、外へも取りに行かない
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_SOURCES_ENV, setup } from "./helpers.ts";
import type { Sekisho } from "../src/auth.ts";

const ROUTES: [string, string, unknown?][] = [
  ["GET", "/api/materials?date=2026-11-23"],
  ["POST", "/api/collect", {}],
  ["POST", "/api/ingest", { items: [] }],
  ["GET", "/"],
];

test("トークンが無ければ全部 401", async () => {
  const s = setup();
  for (const [m, p, b] of ROUTES) {
    const r = await s.call(m, p, b, null);
    assert.equal(r.status, 401, `${m} ${p}`);
    assert.deepEqual(r.json, { error: "unauthorized" });
  }
});

test("関所が否認したトークンは 401", async () => {
  const s = setup();
  for (const [m, p, b] of ROUTES) assert.equal((await s.call(m, p, b, "garbage.jwt")).status, 401, `${m} ${p}`);
});

test("allowlist 外の Client ID・ブラウザのユーザーは 403", async () => {
  const s = setup();
  for (const [m, p, b] of ROUTES) {
    assert.equal((await s.call(m, p, b, "other.jwt")).status, 403, `${m} ${p}`);
    assert.equal((await s.call(m, p, b, "user.jwt")).status, 403, `${m} ${p}`);
  }
});

test("allowlist 内の Client ID は通る（大小を無視）", async () => {
  const s = setup();
  assert.equal((await s.call("GET", "/api/materials?date=2026-11-23")).status, 200);
  assert.equal((await s.call("POST", "/api/ingest", { items: [] })).status, 200);
});

test("ACCESS_SERVICE_CLIENT_IDS が未設定・空なら1本も通さない（403）", async () => {
  assert.equal((await setup({ env: { ACCESS_SERVICE_CLIENT_IDS: "" } }).call("GET", "/api/materials?date=2026-11-23")).status, 403);
  assert.equal((await setup({ env: { ACCESS_SERVICE_CLIENT_IDS: undefined } }).call("GET", "/api/materials?date=2026-11-23")).status, 403);
});

test("設定漏れ・関所の故障は 401（fail-closed）", async () => {
  assert.equal((await setup({ env: { CF_ACCESS_AUD: "" } }).call("GET", "/api/materials?date=2026-11-23")).status, 401);
  assert.equal((await setup({ env: { SEKISHO: undefined } }).call("GET", "/api/materials?date=2026-11-23")).status, 401);
  const broken: Sekisho = {
    verify: async () => {
      throw new Error("down");
    },
  };
  assert.equal((await setup({ env: { SEKISHO: broken } }).call("GET", "/api/materials?date=2026-11-23")).status, 401);
  const weird = { verify: async () => ({ kind: "service" }) } as unknown as Sekisho;
  assert.equal((await setup({ env: { SEKISHO: weird } }).call("GET", "/api/materials?date=2026-11-23")).status, 401);
});

test("拒んだ要求では書き込まれず、外へも取りに行かない", async () => {
  const s = setup({ env: ALL_SOURCES_ENV });
  await s.call("POST", "/api/collect", {}, "other.jwt");
  await s.call("POST", "/api/collect", {}, null);
  await s.call("POST", "/api/ingest", { items: [{ source: "vault-log", external_id: "x", date: "2026-11-23", title: "t" }] }, "user.jwt");
  assert.equal(s.count("SELECT COUNT(*) AS n FROM materials"), 0);
  assert.equal(s.count("SELECT COUNT(*) AS n FROM collect_log"), 0);
  assert.equal(s.web.calls.length, 0);
});

test("ローカル開発の迂回は __LOCAL_DEV__ が無ければ効かない", async () => {
  const s = setup({ env: { DEV_BYPASS_AUTH: "1" } });
  assert.equal((await s.call("GET", "/api/materials?date=2026-11-23", undefined, null)).status, 401);
});
