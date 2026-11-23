// 日付と時刻。港の「日」は JST（+09:00）で切る。夏時間は無い

const JST_MS = 9 * 3600_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD が暦にある日か */
export function isDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** その瞬間の JST の日付 */
export function jstDate(d: Date): string {
  const t = new Date(d.getTime() + JST_MS);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** その瞬間の JST の時（0〜23） */
export function jstHour(d: Date): number {
  return new Date(d.getTime() + JST_MS).getUTCHours();
}

/** その瞬間を +09:00 付きの ISO8601 に（秒まで） */
export function toJstIso(d: Date): string {
  const t = new Date(d.getTime() + JST_MS);
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` +
    `T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}+09:00`
  );
}

/** 時刻の文字列（ISO8601・オフセット付き）を +09:00 付きに。読めなければ null */
export function normalizeInstant(s: unknown): string | null {
  if (typeof s !== "string" || !s) return null;
  // オフセットの無い日時は曖昧なので受けない（Z か ±hh:mm が要る）
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? toJstIso(new Date(t)) : null;
}

/** JST のその日の [from, to)（UTC の ISO8601） */
export function jstDayRange(date: string): { from: string; to: string } | null {
  if (!isDate(date)) return null;
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const start = Date.UTC(y, mo - 1, d) - JST_MS;
  return { from: new Date(start).toISOString(), to: new Date(start + 86400_000).toISOString() };
}

/** 前の日・次の日 */
export function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d) + n * 86400_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 日付をまたいだ直後とみなす JST の時の上限（この時より前なら前日分も集める）。1回の取りこぼしに耐えるよう 0〜2時 */
export const CARRY_OVER_HOURS = 3;

/** cron が集める日: 当日。日付をまたいだ直後（JST 0〜2時台）は前日も */
export function datesToCollect(now: Date): string[] {
  const today = jstDate(now);
  return jstHour(now) < CARRY_OVER_HOURS ? [addDays(today, -1), today] : [today];
}
