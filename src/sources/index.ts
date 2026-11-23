// cron と手動の「今すぐ集める」が回す出どころ（並びは集める順）。
// Mac から送られてくるもの（vault-log・ambient）はここに無い（POST /api/ingest）。
//
// 作っていない出どころ（README の「作っていないもの」）:
//   - Amazon の購入・カードの利用（Notion）… Amazon の DB は空、カードの DB は 2026-07 から記録が止まっている
//   - Google カレンダー … Worker から通る簡単な認証の形が無い（OAuth の同意と更新トークンの管理が要る）
import { health } from "./health.ts";
import { hevy } from "./hevy.ts";
import { nobu } from "./nobu.ts";
import { tayori } from "./tayori.ts";
import type { Source } from "./types.ts";
import { weather } from "./weather.ts";

export const SOURCES: Source[] = [tayori, nobu, health, hevy, weather];

/** Mac から受け取る出どころ（POST /api/ingest が受けるのはこれだけ。cron の出どころを上書きさせない） */
export const INGEST_SOURCES: Record<string, string> = {
  "vault-log": "ヘスティアとのやりとり（vault の log）",
  ambient: "Mac でやったこと（Ambient Context）",
};

/** 見出し（かけら帳に出す名前） */
export function sourceLabel(name: string): string {
  return SOURCES.find((s) => s.name === name)?.label ?? INGEST_SOURCES[name] ?? name;
}
