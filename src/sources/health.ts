// からだ帳（health-sync-cloud）: GET {HEALTH_URL}/v1/app/day/:date（その日の体の記録）と
// GET {HEALTH_URL}/v1/app/meals?from=&to=（食事）。どちらもヘスティア役のサービストークンで読める口
import { normalizeInstant } from "../dates.ts";
import type { MaterialInput } from "../store.ts";
import { accessHeaders, baseUrl, getJson, missing, UpstreamError, type Source } from "./types.ts";

interface DayMetric {
  metric: string;
  label: string | null;
  unit: string | null;
  decimals: number | null;
  status: string;
  value: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  seconds: number | null;
}
interface DayBody {
  date: string;
  metrics?: DayMetric[];
  sleep?: Record<string, unknown> | null;
}
interface Meal {
  id: string;
  slot: string;
  eaten_at: string | null;
  items: string;
  kcal: number;
  p: number;
  f: number;
  c: number;
}
interface MealsBody {
  days?: { date: string; meals: Meal[]; total: Record<string, number> | null; note: string | null }[];
}

const SLOT_LABEL: Record<string, string> = { breakfast: "朝食", lunch: "昼食", dinner: "夕食", snack: "間食" };

/** 見出しに出す数（あるものだけ） */
function headline(metrics: DayMetric[]): string {
  const parts: string[] = [];
  const steps = metrics.find((m) => m.metric === "steps" && typeof m.value === "number");
  if (steps) parts.push(`歩数 ${Math.round(steps.value!).toLocaleString("en-US")}歩`);
  const kcal = metrics.find((m) => m.metric === "active_energy" && typeof m.value === "number");
  if (kcal) parts.push(`消費 ${Math.round(kcal.value!)}kcal`);
  return parts.length ? `からだ帳: ${parts.join("・")}` : "からだ帳の記録";
}

export const health: Source = {
  name: "health",
  label: "からだ帳",
  async collect(date, ctx) {
    const lack = missing(ctx.env, ["HEALTH_URL", "HEALTH_CLIENT_ID", "HEALTH_CLIENT_SECRET"]);
    if (lack) return { status: "skipped", reason: lack };
    const base = baseUrl(ctx.env.HEALTH_URL)!;
    const headers = accessHeaders(ctx.env.HEALTH_CLIENT_ID!.trim(), ctx.env.HEALTH_CLIENT_SECRET!.trim());
    const items: MaterialInput[] = [];

    // その日の記録が無いと 404（iPhone がまだ送っていない）→ 0 件
    const day = await getJson<DayBody>(ctx, `${base}/v1/app/day/${date}`, { headers, allow404: true });
    if (day) {
      if (!Array.isArray(day.metrics)) throw new UpstreamError("応答の形が違う（metrics が無い）");
      const metrics = day.metrics
        .filter((m) => m && m.status === "ok")
        .map((m) => ({ metric: m.metric, label: m.label, unit: m.unit, decimals: m.decimals, value: m.value, avg: m.avg, min: m.min, max: m.max, seconds: m.seconds }));
      items.push({
        source: "health",
        external_id: `day:${date}`,
        occurred_at: null,
        date,
        title: headline(day.metrics),
        url: null,
        detail: { kind: "day", metrics, sleep: day.sleep ?? null },
      });
    }

    const meals = await getJson<MealsBody>(ctx, `${base}/v1/app/meals?from=${date}&to=${date}`, { headers });
    if (!meals || !Array.isArray(meals.days)) throw new UpstreamError("応答の形が違う（days が無い）");
    for (const d of meals.days) {
      if (d.date !== date) continue;
      for (const m of d.meals ?? []) {
        items.push({
          source: "health",
          external_id: `meal:${m.id}`,
          occurred_at: normalizeInstant(m.eaten_at),
          date,
          title: `${SLOT_LABEL[m.slot] ?? m.slot}: ${m.items}`,
          url: null,
          detail: { kind: "meal", slot: m.slot, eaten_at: m.eaten_at, kcal: m.kcal, p: m.p, f: m.f, c: m.c },
        });
      }
      if (d.note) {
        items.push({ source: "health", external_id: `note:${date}`, occurred_at: null, date, title: `ひとこと: ${d.note}`, url: null, detail: { kind: "note" } });
      }
    }
    return { status: "ok", items };
  },
};
