// 天気: Open-Meteo（鍵不要）。場所は secret の WEATHER_LATITUDE / WEATHER_LONGITUDE（リポジトリに座標を書かない）。
// 当日は予報込みの値なので、1時間ごとに入れ直す。60 日より前の日は過去データの口（archive-api）へ
import { addDays, jstDate } from "../dates.ts";
import { getJson, missing, UpstreamError, type Source } from "./types.ts";

/** WMO の天気コード → ことば */
export function weatherLabel(code: number): string {
  if (code === 0) return "快晴";
  if (code === 1) return "晴れ";
  if (code === 2) return "晴れ時々くもり";
  if (code === 3) return "くもり";
  if (code === 45 || code === 48) return "霧";
  if (code >= 51 && code <= 57) return "霧雨";
  if (code === 61 || code === 80) return "小雨";
  if (code === 63 || code === 81) return "雨";
  if (code === 65 || code === 82) return "強い雨";
  if (code === 66 || code === 67) return "冷たい雨";
  if (code === 71 || code === 85) return "小雪";
  if (code === 73 || code === 75 || code === 77 || code === 86) return "雪";
  if (code === 95) return "雷雨";
  if (code === 96 || code === 99) return "ひょうを伴う雷雨";
  return `天気コード ${code}`;
}

function coord(raw: string | undefined, max: number): number | null {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && Math.abs(n) <= max ? n : null;
}

interface Daily {
  time?: string[];
  weather_code?: (number | null)[];
  temperature_2m_max?: (number | null)[];
  temperature_2m_min?: (number | null)[];
  precipitation_sum?: (number | null)[];
}

export const ARCHIVE_AFTER_DAYS = 60;

export const weather: Source = {
  name: "weather",
  label: "天気",
  async collect(date, ctx) {
    const lack = missing(ctx.env, ["WEATHER_LATITUDE", "WEATHER_LONGITUDE"]);
    if (lack) return { status: "skipped", reason: lack };
    const lat = coord(ctx.env.WEATHER_LATITUDE, 90);
    const lon = coord(ctx.env.WEATHER_LONGITUDE, 180);
    if (lat === null || lon === null) return { status: "skipped", reason: "WEATHER_LATITUDE / WEATHER_LONGITUDE が数として読めない" };
    if (date > jstDate(ctx.now)) return { status: "skipped", reason: "未来の日" };
    const host = date < addDays(jstDate(ctx.now), -ARCHIVE_AFTER_DAYS) ? "https://archive-api.open-meteo.com/v1/archive" : "https://api.open-meteo.com/v1/forecast";
    const q = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum",
      timezone: "Asia/Tokyo",
      start_date: date,
      end_date: date,
    });
    const body = await getJson<{ daily?: Daily }>(ctx, `${host}?${q}`);
    const d = body?.daily;
    if (!d || !Array.isArray(d.time)) throw new UpstreamError("応答の形が違う（daily が無い）");
    const i = d.time.indexOf(date);
    if (i < 0) return { status: "ok", items: [] };
    const code = d.weather_code?.[i] ?? null;
    const max = d.temperature_2m_max?.[i] ?? null;
    const min = d.temperature_2m_min?.[i] ?? null;
    const rain = d.precipitation_sum?.[i] ?? null;
    if (code === null && max === null && min === null) return { status: "ok", items: [] };
    const parts = [code !== null ? weatherLabel(code) : "天気"];
    if (max !== null && min !== null) parts.push(`最高 ${max}℃／最低 ${min}℃`);
    if (rain !== null && rain > 0) parts.push(`降水 ${rain}mm`);
    return {
      status: "ok",
      items: [
        {
          source: "weather",
          external_id: `day:${date}`,
          occurred_at: null,
          date,
          title: parts.join("・"),
          url: null,
          // 座標は入れない
          detail: { weather_code: code, temperature_max: max, temperature_min: min, precipitation_sum: rain },
        },
      ],
    };
  },
};
