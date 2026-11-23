// Mac の送り出し（scripts/send-to-minato.mjs）: log の見出しの拾い方・id が上に足してもずれない・要約の有無
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPayload, datesToSend, parseVaultLog } from "../scripts/send-to-minato.mjs";

const LOG = `---
type: meta
---

## 2026-11-23 | 開発 | 港を作った
本文1
本文2

## 2026-11-23 | 暮らし | カード利用チェック
a

## 2026-11-22 | 暮らし | カード利用チェック
b

## 2026-11-23 | 暮らし | カード利用チェック
c
## 見出しの形が違うもの
x
`;

test("その日の見出しだけ・新しい順・本文つき。形の違う見出しは拾わない", () => {
  const items = parseVaultLog(LOG, "2026-11-23");
  assert.deepEqual(items.map((i) => i.title), ["開発 | 港を作った", "暮らし | カード利用チェック", "暮らし | カード利用チェック"]);
  assert.equal(items[0].detail.body, "本文1\n本文2");
  assert.equal(items[2].detail.body, "c");
  assert.equal(new Set(items.map((i) => i.external_id)).size, 3);
  for (const i of items) assert.equal(i.source, "vault-log");
});

test("上に新しい見出しが足されても、既存の id は変わらない", () => {
  const before = parseVaultLog(LOG, "2026-11-23");
  const after = parseVaultLog(LOG.replace("---\n\n", "---\n\n## 2026-11-23 | 暮らし | カード利用チェック\nd\n\n"), "2026-11-23");
  assert.equal(after.length, 4);
  const ids = new Set(after.map((i) => i.external_id));
  for (const b of before) assert.ok(ids.has(b.external_id), b.title);
});

test("要約があれば ambient も送り、無ければ送らず入れ替えもしない", () => {
  const dir = mkdtempSync(join(tmpdir(), "amb-"));
  let p = buildPayload("2026-11-23", LOG, dir);
  assert.deepEqual(p.replace, [{ source: "vault-log", date: "2026-11-23" }]);
  mkdirSync(join(dir, "Summaries"));
  writeFileSync(join(dir, "Summaries", "2026-11-23.md"), "# 港の日\n\n09:00-10:00 設計した\n");
  p = buildPayload("2026-11-23", LOG, dir);
  const a = p.items.find((i) => i.source === "ambient");
  assert.equal(a.title, "港の日");
  assert.equal(a.external_id, "summary:2026-11-23");
  assert.deepEqual(p.replace.map((r) => r.source), ["vault-log", "ambient"]);
  // log が読めなかったときは vault-log を入れ替えない
  assert.deepEqual(buildPayload("2026-11-23", null, dir).replace.map((r) => r.source), ["ambient"]);
});

test("送る日: JST 0〜2時台は前日も", () => {
  assert.deepEqual(datesToSend(new Date("2026-11-23T15:10:00Z")), ["2026-11-23", "2026-11-24"]);
  assert.deepEqual(datesToSend(new Date("2026-11-23T18:10:00Z")), ["2026-11-24"]);
});
