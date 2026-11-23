// 便りの既読: GET {TAYORI_URL}/api/items/read-on?date=YYYY-MM-DD（read_at が JST のその日の記事）
import { jstDate, normalizeInstant } from "../dates.ts";
import type { MaterialInput } from "../store.ts";
import { accessHeaders, baseUrl, getJson, missing, UpstreamError, type Source } from "./types.ts";

interface ReadOnItem {
  id: number;
  feed_title: string | null;
  title: string;
  url: string | null;
  published_at: string | null;
  read_at: string | null;
  comment: string | null;
}

export const tayori: Source = {
  name: "tayori",
  label: "便りで読んだ記事",
  async collect(date, ctx) {
    const lack = missing(ctx.env, ["TAYORI_URL", "TAYORI_CLIENT_ID", "TAYORI_CLIENT_SECRET"]);
    if (lack) return { status: "skipped", reason: lack };
    const base = baseUrl(ctx.env.TAYORI_URL)!;
    const body = await getJson<{ items?: ReadOnItem[] }>(ctx, `${base}/api/items/read-on?date=${date}`, {
      headers: accessHeaders(ctx.env.TAYORI_CLIENT_ID!.trim(), ctx.env.TAYORI_CLIENT_SECRET!.trim()),
    });
    if (!body || !Array.isArray(body.items)) throw new UpstreamError("応答の形が違う（items が無い）");
    const items: MaterialInput[] = [];
    for (const it of body.items) {
      if (typeof it?.id !== "number" || typeof it.title !== "string") continue;
      const at = normalizeInstant(it.read_at);
      // 便りが JST の日で切って返すので一致するはずだが、ずれたものは入れない
      if (at && jstDate(new Date(at)) !== date) continue;
      items.push({
        source: "tayori",
        external_id: `item:${it.id}`,
        occurred_at: at,
        date,
        title: it.title,
        url: typeof it.url === "string" && it.url ? it.url : null,
        detail: { feed_title: it.feed_title ?? null, comment: it.comment ?? null, published_at: it.published_at ?? null },
      });
    }
    return { status: "ok", items };
  },
};
