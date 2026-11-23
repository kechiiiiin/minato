// テストの下まわり: D1（node:sqlite）・関所のモック・差し替えられる fetch と時計
import { createApp } from "../src/app.ts";
import type { CollectDeps } from "../src/collect.ts";
import type { Env } from "../src/env.ts";
import type { Sekisho } from "../src/auth.ts";
import { makeDb } from "./d1shim.ts";

export const AUD = "test-aud";
export const CLIENT_ID = "abc123def456.access";

/** 関所のふり: "ok.jwt" = 許可された Client ID、"other.jwt" = 許可外の Client ID、"user.jwt" = ブラウザのユーザー */
export function mockSekisho(): Sekisho {
  return {
    async verify(token, aud, opts) {
      if (aud !== AUD || opts?.allowServiceTokens !== true) return null;
      if (token === "ok.jwt") return { kind: "service", clientId: CLIENT_ID.toUpperCase() };
      if (token === "other.jwt") return { kind: "service", clientId: "9999.access" };
      if (token === "user.jwt") return { kind: "user", email: "someone@example.com" };
      return null;
    },
  };
}

export class Clock {
  t: number;
  constructor(iso: string) {
    this.t = Date.parse(iso);
  }
  now = () => new Date(this.t);
  set(iso: string) {
    this.t = Date.parse(iso);
  }
}

export interface Route {
  status?: number;
  json?: unknown;
  body?: string;
  headers?: Record<string, string>;
  throws?: boolean;
}

/** URL → 応答 の表で答える fetch。呼ばれた URL と送られたヘッダを残す（表に無い URL は 404） */
export class MockWeb {
  routes = new Map<string, Route>();
  calls: { url: string; headers: Record<string, string>; redirect?: string }[] = [];
  set(url: string, r: Route) {
    this.routes.set(url, r);
  }
  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    this.calls.push({ url: input, headers, redirect: init?.redirect });
    const r = this.routes.get(input);
    if (!r) return new Response("not found", { status: 404 });
    if (r.throws) throw new TypeError("network");
    const body = r.json !== undefined ? JSON.stringify(r.json) : (r.body ?? "");
    return new Response(body, { status: r.status ?? 200, headers: { "Content-Type": "application/json", ...(r.headers ?? {}) } });
  };
}

/** 出どころの設定をそろえた env（テスト用の値） */
export const ALL_SOURCES_ENV: Partial<Env> = {
  TAYORI_URL: "https://tayori.example",
  TAYORI_CLIENT_ID: "tayori-id",
  TAYORI_CLIENT_SECRET: "tayori-secret",
  NOBU_URL: "https://nobu.example/",
  NOBU_CLIENT_ID: "nobu-id",
  NOBU_CLIENT_SECRET: "nobu-secret",
  HEALTH_URL: "https://health.example",
  HEALTH_CLIENT_ID: "health-id",
  HEALTH_CLIENT_SECRET: "health-secret",
  WEATHER_LATITUDE: "35.0",
  WEATHER_LONGITUDE: "139.0",
  HEVY_API_KEY: "hevy-key",
};

export function setup(o: { now?: string; env?: Partial<Env> } = {}) {
  const { db, raw } = makeDb();
  const clock = new Clock(o.now ?? "2026-11-23T03:00:00Z");
  const web = new MockWeb();
  const env = {
    DB: db,
    SEKISHO: mockSekisho(),
    CF_ACCESS_AUD: AUD,
    ACCESS_SERVICE_CLIENT_IDS: CLIENT_ID,
    ...o.env,
  } as Env;
  const deps: CollectDeps = { now: clock.now, fetch: web.fetch };
  const app = createApp(deps);
  const ctx = { waitUntil: () => {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

  async function call(method: string, path: string, body?: unknown, token: string | null = "ok.jwt") {
    const headers: Record<string, string> = {};
    if (token) headers["Cf-Access-Jwt-Assertion"] = token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await app.request(
      `https://minato.example.com${path}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      env,
      ctx,
    );
    const json = (await res.json()) as any;
    return { status: res.status, json };
  }
  function count(sql: string, ...args: (string | number | null)[]): number {
    return Number((raw.prepare(sql).get(...args) as { n: number }).n);
  }
  return { db, raw, clock, web, env, deps, call, count };
}
