// NoBu の読書記録: GET {NOBU_URL}/api/timeline（新しい順・ページング）から、JST のその日の分を拾う。
//   - kind "status" … 状態の変化（本1冊・時刻あり）
//   - kind "read"   … その日に読んだ本（日単位・時刻なし）。同じ日に状態も変えた本は NoBu 側で省かれている
import { normalizeInstant } from "../dates.ts";
import type { MaterialInput } from "../store.ts";
import { accessHeaders, baseUrl, getJson, missing, UpstreamError, type Source } from "./types.ts";

type Status = "want" | "bought" | "reading" | "paused" | "read" | "digesting";
interface TimelineBook {
  id: number;
  title: string;
  cover_url: string | null;
}
type TimelineItem =
  | { kind: "status"; cursor: string; day: string; event_id: number; at: string; from_status: Status | null; to_status: Status; book: TimelineBook }
  | { kind: "read"; cursor: string; day: string; books: TimelineBook[] };

/** 1回に読むページの上限（1ページ 100 件）。1日でこれを超えることはまず無い */
export const NOBU_MAX_PAGES = 5;

/** NoBu の shared/types.ts の eventLabel と同じ言い方 */
export function eventLabel(from: Status | null, to: Status): string {
  if (to === "reading" && from === "paused") return "読書を再開した";
  if (to === "read" && from === "digesting") return "深め終えた";
  const m: Record<Status, string> = {
    want: "気になるに入れた",
    bought: "買った",
    reading: "読み始めた",
    paused: "保留にした",
    read: "読了",
    digesting: "理解を深めはじめた",
  };
  return m[to] ?? to;
}

export const nobu: Source = {
  name: "nobu",
  label: "読書（NoBu）",
  async collect(date, ctx) {
    const lack = missing(ctx.env, ["NOBU_URL", "NOBU_CLIENT_ID", "NOBU_CLIENT_SECRET"]);
    if (lack) return { status: "skipped", reason: lack };
    const base = baseUrl(ctx.env.NOBU_URL)!;
    const headers = accessHeaders(ctx.env.NOBU_CLIENT_ID!.trim(), ctx.env.NOBU_CLIENT_SECRET!.trim());
    const items: MaterialInput[] = [];
    let before: string | null = null;
    for (let page = 0; page < NOBU_MAX_PAGES; page++) {
      const q: string = `limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`;
      const body: { items?: TimelineItem[]; next?: string | null } | null = await getJson(ctx, `${base}/api/timeline?${q}`, { headers });
      if (!body || !Array.isArray(body.items)) throw new UpstreamError("応答の形が違う（items が無い）");
      let older = false;
      for (const it of body.items) {
        if (it.day > date) continue;
        if (it.day < date) {
          older = true;
          break;
        }
        if (it.kind === "status") {
          items.push({
            source: "nobu",
            external_id: `event:${it.event_id}`,
            occurred_at: normalizeInstant(it.at),
            date,
            title: `${eventLabel(it.from_status, it.to_status)}: ${it.book.title}`,
            url: null,
            detail: { kind: "status", book_id: it.book.id, book_title: it.book.title, from: it.from_status, to: it.to_status, cover_url: it.book.cover_url },
          });
        } else if (it.kind === "read") {
          for (const b of it.books) {
            items.push({
              source: "nobu",
              external_id: `read:${date}:${b.id}`,
              occurred_at: null,
              date,
              title: `読んだ: ${b.title}`,
              url: null,
              detail: { kind: "read", book_id: b.id, book_title: b.title, cover_url: b.cover_url },
            });
          }
        }
      }
      if (older || !body.next) return { status: "ok", items };
      before = body.next;
    }
    throw new UpstreamError(`${NOBU_MAX_PAGES} ページ読んでもその日に届かない`);
  },
};
