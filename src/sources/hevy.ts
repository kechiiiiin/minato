// Hevy の筋トレ: 公開 API（https://api.hevyapp.com・ヘッダ api-key・Hevy Pro で発行できる鍵）。
// GET /v1/workouts?page=&pageSize=10 を新しい順とみなして読み、start_time が JST のその日のものを拾う。
// 並び順は API の文書に書かれていないので、ページの中に「その日より前」しか無くなったら止め、上限は HEVY_MAX_PAGES
import { jstDate, normalizeInstant } from "../dates.ts";
import type { MaterialInput } from "../store.ts";
import { getJson, missing, UpstreamError, type Source } from "./types.ts";

interface HevySet {
  type?: string;
  weight_kg?: number | null;
  reps?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
}
interface HevyWorkout {
  id: string;
  title: string;
  description?: string | null;
  start_time: string;
  end_time?: string | null;
  exercises?: { title: string; sets?: HevySet[] }[];
}

export const HEVY_API = "https://api.hevyapp.com";
export const HEVY_MAX_PAGES = 5;

export const hevy: Source = {
  name: "hevy",
  label: "筋トレ（Hevy）",
  async collect(date, ctx) {
    const lack = missing(ctx.env, ["HEVY_API_KEY"]);
    if (lack) return { status: "skipped", reason: lack };
    const headers = { "api-key": ctx.env.HEVY_API_KEY!.trim() };
    const items: MaterialInput[] = [];
    for (let page = 1; page <= HEVY_MAX_PAGES; page++) {
      const body = await getJson<{ page?: number; page_count?: number; workouts?: HevyWorkout[] }>(
        ctx,
        `${HEVY_API}/v1/workouts?page=${page}&pageSize=10`,
        { headers, allow404: true },
      );
      // ワークアウトが1つも無いと 404 が返ることがある
      if (!body) break;
      if (!Array.isArray(body.workouts)) throw new UpstreamError("応答の形が違う（workouts が無い）");
      let newer = false;
      for (const w of body.workouts) {
        const at = normalizeInstant(w.start_time);
        if (!at) continue;
        const d = jstDate(new Date(at));
        if (d >= date) newer = true;
        if (d !== date) continue;
        items.push({
          source: "hevy",
          external_id: `workout:${w.id}`,
          occurred_at: at,
          date,
          title: w.title || "ワークアウト",
          url: null,
          detail: {
            end_time: normalizeInstant(w.end_time),
            description: w.description ?? null,
            exercises: (w.exercises ?? []).map((e) => ({
              title: e.title,
              sets: (e.sets ?? []).map((s) => ({ type: s.type ?? null, weight_kg: s.weight_kg ?? null, reps: s.reps ?? null, distance_meters: s.distance_meters ?? null, duration_seconds: s.duration_seconds ?? null })),
            })),
          },
        });
      }
      if (!newer || page >= (body.page_count ?? 1) || body.workouts.length === 0) break;
    }
    return { status: "ok", items };
  },
};
