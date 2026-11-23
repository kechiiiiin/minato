// JST の日の境目
import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, datesToCollect, isDate, jstDate, jstDayRange, normalizeInstant, toJstIso } from "../src/dates.ts";

test("jstDate: UTC 14:59:59 はその日、15:00 ちょうどから翌日", () => {
  assert.equal(jstDate(new Date("2026-11-23T14:59:59.999Z")), "2026-11-23");
  assert.equal(jstDate(new Date("2026-11-23T15:00:00.000Z")), "2026-11-24");
  assert.equal(jstDate(new Date("2026-12-31T15:00:00Z")), "2027-01-01");
});

test("toJstIso / normalizeInstant: +09:00 付きにそろえる。オフセットの無い日時は受けない", () => {
  assert.equal(toJstIso(new Date("2026-11-23T15:00:00Z")), "2026-11-24T00:00:00+09:00");
  assert.equal(normalizeInstant("2026-11-23T08:30:00Z"), "2026-11-23T17:30:00+09:00");
  assert.equal(normalizeInstant("2026-11-23T23:59:59+09:00"), "2026-11-23T23:59:59+09:00");
  assert.equal(normalizeInstant("2026-11-23T10:00:00-05:00"), "2026-11-24T00:00:00+09:00");
  for (const bad of ["2026-11-23T10:00:00", "", "abc", null, 3]) assert.equal(normalizeInstant(bad), null, String(bad));
});

test("jstDayRange: JST 0:00 は前日 UTC 15:00。暦に無い日は null", () => {
  assert.deepEqual(jstDayRange("2026-11-23"), { from: "2026-11-22T15:00:00.000Z", to: "2026-11-23T15:00:00.000Z" });
  for (const bad of ["2026-11-31", "2026-02-29", "2026-1-1", "2026/11/23", ""]) assert.equal(jstDayRange(bad), null, bad);
  assert.ok(isDate("2028-02-29"));
  assert.equal(addDays("2027-01-01", -1), "2026-12-31");
});

test("datesToCollect: JST 0〜2時台は前日も、3時からは当日だけ", () => {
  assert.deepEqual(datesToCollect(new Date("2026-11-23T15:05:00Z")), ["2026-11-23", "2026-11-24"]); // JST 11/24 0:05
  assert.deepEqual(datesToCollect(new Date("2026-11-23T17:59:59Z")), ["2026-11-23", "2026-11-24"]); // JST 2:59
  assert.deepEqual(datesToCollect(new Date("2026-11-23T18:00:00Z")), ["2026-11-24"]); // JST 3:00
  assert.deepEqual(datesToCollect(new Date("2026-11-23T14:59:00Z")), ["2026-11-23"]); // JST 23:59
});
