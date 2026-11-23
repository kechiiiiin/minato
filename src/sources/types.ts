// 出どころのモジュールの形。必要な secret・設定が無いものは { status: "skipped", reason } を返す（throw しない）。
// 取りに行って失敗したら throw する（collect.ts が error として理由を残す）。
import type { Env } from "../env.ts";
import type { MaterialInput } from "../store.ts";

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface SourceContext {
  env: Env;
  fetch: Fetcher;
  now: Date;
}

export type SourceResult = { status: "ok"; items: MaterialInput[] } | { status: "skipped"; reason: string };

export interface Source {
  /** materials.source に入る名前 */
  name: string;
  /** 人が読む名前（かけら帳の見出し） */
  label: string;
  collect(date: string, ctx: SourceContext): Promise<SourceResult>;
}

/** 取りに行った先の失敗。message はそのまま collect_log.reason に残る（秘密を入れない） */
export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

/** 1回の取りに行きの上限 */
export const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * JSON を取る。リダイレクトは追わない（Access のログイン画面へ飛ばされたら＝トークンが通っていない）。
 * 404 を null で返すかは allow404 で選ぶ
 */
export async function getJson<T>(
  ctx: SourceContext,
  url: string,
  init: { headers?: Record<string, string>; method?: string; body?: string; allow404?: boolean } = {},
): Promise<T | null> {
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method: init.method ?? "GET",
      headers: { Accept: "application/json", ...(init.headers ?? {}) },
      body: init.body,
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    throw new UpstreamError(`通信できない（${e instanceof Error ? e.name : "error"}）`);
  }
  if (init.allow404 && res.status === 404) return null;
  if (res.status >= 300 && res.status < 400) throw new UpstreamError(`HTTP ${res.status}（Access のログインへ回された＝トークンが通っていない）`);
  if (!res.ok) throw new UpstreamError(`HTTP ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new UpstreamError("JSON ではない応答");
  }
}

/** Access のサービストークンのヘッダ */
export function accessHeaders(id: string, secret: string): Record<string, string> {
  return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
}

/** 末尾の / を落とした URL。空なら null */
export function baseUrl(raw: string | undefined): string | null {
  const s = (raw ?? "").trim().replace(/\/+$/, "");
  return s ? s : null;
}

/** 欠けている設定の名前を並べる（無ければ null） */
export function missing(env: Env, names: (keyof Env)[]): string | null {
  const m = names.filter((n) => {
    const v = env[n];
    return typeof v !== "string" || v.trim() === "";
  });
  return m.length ? `${m.join(" / ")} が未設定` : null;
}
