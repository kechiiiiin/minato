// POST /api/ingest（Mac から配列で upsert）の検査。受けるのは INGEST_SOURCES の出どころだけ
import { isDate, normalizeInstant } from "./dates.ts";
import { INGEST_SOURCES } from "./sources/index.ts";
import type { MaterialInput } from "./store.ts";

export const INGEST_MAX_ITEMS = 500;
const MAX_TITLE = 500;
const MAX_EXTERNAL_ID = 200;
const MAX_DETAIL_BYTES = 64 * 1024;

export type IngestParsed =
  | { ok: true; items: MaterialInput[]; replace: { source: string; date: string }[] }
  | { ok: false; error: string; index?: number };

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseUrl(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "obsidian:" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 本文: { items: [{ source, external_id, date, occurred_at?, title, url?, detail? }], replace?: [{ source, date }] }
 * replace に挙げた (source, date) は「送ったものがその日の全部」として、送らなかった古い行を消す
 */
export function parseIngest(body: unknown): IngestParsed {
  if (!isObj(body) || !Array.isArray(body.items)) return { ok: false, error: "items_required" };
  if (body.items.length > INGEST_MAX_ITEMS) return { ok: false, error: "too_many_items" };
  const items: MaterialInput[] = [];
  for (let i = 0; i < body.items.length; i++) {
    const v = body.items[i];
    if (!isObj(v)) return { ok: false, error: "bad_item", index: i };
    const source = v.source;
    if (typeof source !== "string" || !Object.hasOwn(INGEST_SOURCES, source)) return { ok: false, error: "bad_source", index: i };
    const ext = v.external_id;
    if (typeof ext !== "string" || !ext || ext.length > MAX_EXTERNAL_ID) return { ok: false, error: "bad_external_id", index: i };
    if (!isDate(v.date)) return { ok: false, error: "bad_date", index: i };
    let occurred: string | null = null;
    if (v.occurred_at !== undefined && v.occurred_at !== null) {
      occurred = normalizeInstant(v.occurred_at);
      if (!occurred) return { ok: false, error: "bad_occurred_at", index: i };
    }
    const title = typeof v.title === "string" ? v.title.trim() : "";
    if (!title || title.length > MAX_TITLE) return { ok: false, error: "bad_title", index: i };
    const url = parseUrl(v.url);
    if (url === undefined) return { ok: false, error: "bad_url", index: i };
    const detail = v.detail === undefined ? {} : v.detail;
    if (!isObj(detail)) return { ok: false, error: "bad_detail", index: i };
    if (new TextEncoder().encode(JSON.stringify(detail)).length > MAX_DETAIL_BYTES) return { ok: false, error: "detail_too_large", index: i };
    items.push({ source, external_id: ext, occurred_at: occurred, date: v.date as string, title, url, detail });
  }
  const replace: { source: string; date: string }[] = [];
  if (body.replace !== undefined) {
    if (!Array.isArray(body.replace) || body.replace.length > 50) return { ok: false, error: "bad_replace" };
    for (const r of body.replace) {
      if (!isObj(r) || typeof r.source !== "string" || !Object.hasOwn(INGEST_SOURCES, r.source) || !isDate(r.date)) return { ok: false, error: "bad_replace" };
      replace.push({ source: r.source, date: r.date as string });
    }
  }
  return { ok: true, items, replace };
}
