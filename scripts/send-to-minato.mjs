#!/usr/bin/env node
// Mac から港へ、その日の材料を送る（launchd で1時間ごと）。
//   - vault-log  … jinsei vault の hestia/log.md の見出し `## YYYY-MM-DD | 種別 | タイトル`（本文も少し）
//   - ambient    … Ambient Context のその日の要約（~/ambient-context/Summaries/YYYY-MM-DD.md があるときだけ）
//   - rururu-paw … rururu の「自分のチャンネルへの足あと」（rururu CLI の pawprints list --scope to_me）
// 送る日は JST の今日。日付をまたいだ直後（JST 0〜2時台）は前日も送る（港の cron と同じ）。
// 送るたびに「その日の全部」として入れ替える（replace）。log から消した見出しは港からも消える。
// rururu CLI が失敗したとき（未ログイン・sandbox など）は rururu-paw を入れ替えない（港の分を消さない）。
//
// トークンは Mac のキーチェーン（サービス名 kakera-token・アカウント client-id / client-secret。かけら帳と同じ）。
// 値は表示しない。
//
// 使い方:
//   node scripts/send-to-minato.mjs                 # 今日（と 0〜2時台は前日）を送る
//   node scripts/send-to-minato.mjs --date 2026-11-23
//   node scripts/send-to-minato.mjs --dry-run       # 送らずに中身の件数と見出しだけ表示
//   MINATO_URL=http://127.0.0.1:8793 node scripts/send-to-minato.mjs   # ローカルの npm run dev へ
//
// 環境変数（無ければ既定）:
//   MINATO_URL         既定 https://minato.kechiiiiin.com
//   MINATO_VAULT_LOG   既定 ~/Library/Mobile Documents/iCloud~md~obsidian/Documents/jinsei/hestia/log.md
//   MINATO_AMBIENT_DIR 既定 ~/ambient-context
//   MINATO_KEYCHAIN    既定 kakera-token
//   MINATO_RURURU      既定 ~/.local/bin/rururu（rururu CLI の実行ファイル）

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOME = homedir();
const URL_BASE = (process.env.MINATO_URL ?? "https://minato.kechiiiiin.com").replace(/\/+$/, "");
const VAULT_LOG = process.env.MINATO_VAULT_LOG ?? join(HOME, "Library/Mobile Documents/iCloud~md~obsidian/Documents/jinsei/hestia/log.md");
const AMBIENT_DIR = process.env.MINATO_AMBIENT_DIR ?? join(HOME, "ambient-context");
const KEYCHAIN = process.env.MINATO_KEYCHAIN ?? "kakera-token";
const RURURU_BIN = process.env.MINATO_RURURU ?? join(HOME, ".local/bin/rururu");

const BODY_MAX = 2000; // log の本文は先頭だけ
const SUMMARY_MAX = 60_000; // 港の detail の上限（64KB）に収める

// ---- 日付（JST）

export function jstParts(d) {
  const t = new Date(d.getTime() + 9 * 3600_000);
  const p = (n) => String(n).padStart(2, "0");
  return { date: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`, hour: t.getUTCHours() };
}

export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400_000);
  return t.toISOString().slice(0, 10);
}

export function datesToSend(now) {
  const { date, hour } = jstParts(now);
  return hour < 3 ? [addDays(date, -1), date] : [date];
}

// ---- vault の log

const HEADING = /^## (\d{4}-\d{2}-\d{2}) \| ([^|]+?) \| (.+?)\s*$/;

/**
 * log.md からその日の見出しを拾う。external_id は「見出しの文字列のハッシュ＋同じ見出しの何個目か（古い方＝下から数える）」。
 * log は新しいものが上に足されるので、下から数えれば既存の id がずれない
 */
export function parseVaultLog(text, date) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let cur = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (cur) entries.push(cur);
      const m = HEADING.exec(line);
      cur = m ? { date: m[1], kind: m[2].trim(), title: m[3].trim(), heading: line.trim(), body: [] } : null;
      continue;
    }
    if (cur) cur.body.push(line);
  }
  if (cur) entries.push(cur);

  const seen = new Map();
  const out = [];
  for (const e of entries.reverse()) {
    if (e.date !== date) continue;
    const n = (seen.get(e.heading) ?? 0) + 1;
    seen.set(e.heading, n);
    const hash = createHash("sha256").update(e.heading).digest("hex").slice(0, 16);
    const body = e.body.join("\n").trim();
    out.push({
      source: "vault-log",
      external_id: `${hash}-${n}`,
      date,
      occurred_at: null,
      title: `${e.kind} | ${e.title}`,
      detail: { kind: e.kind, title: e.title, body: body.length > BODY_MAX ? body.slice(0, BODY_MAX) + "…" : body },
    });
  }
  return out.reverse(); // ファイルの並び（新しい順）に戻す
}

// ---- Ambient Context の要約

export function ambientSummary(dir, date) {
  const p = join(dir, "Summaries", `${date}.md`);
  if (!existsSync(p)) return null;
  const text = readFileSync(p, "utf8").trim();
  if (!text) return null;
  const h = /^#\s+(.+)$/m.exec(text);
  return {
    source: "ambient",
    external_id: `summary:${date}`,
    date,
    occurred_at: null,
    title: h ? h[1].trim() : "Mac でやったこと（Ambient Context の要約）",
    detail: { kind: "summary", body: text.length > SUMMARY_MAX ? text.slice(0, SUMMARY_MAX) + "…" : text },
  };
}

// ---- rururu の足あと

/**
 * rururu CLI（pawprints list --scope to_me --json）を呼ぶ。失敗・JSON が配列でなければ null
 * （null は「取れなかった」の意味。buildPayload はこのとき rururu-paw を入れ替えない）
 */
export function fetchPawprints(bin = RURURU_BIN) {
  try {
    const out = execFileSync(bin, ["pawprints", "list", "--scope", "to_me", "--limit", "50", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
    });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * pawprints list の出力（配列）から、JST の date に作られたものだけを材料にする。
 * list が配列でなければ空（呼び出し側は list===null のときは replace に入れないこと自体で判断する）
 */
export function parsePawprints(list, date) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    const createdAt = p?.createdAt;
    if (typeof createdAt !== "string") continue;
    const t = new Date(createdAt);
    if (Number.isNaN(t.getTime())) continue;
    if (jstParts(t).date !== date) continue;
    const item = p.item ?? {};
    const user = p.user ?? {};
    out.push({
      source: "rururu-paw",
      external_id: `pawprint:${p.id}`,
      date,
      occurred_at: createdAt,
      title: `${user.name ?? "誰か"} が「${item.title ?? ""}」に足あと`,
      url: item.url ?? null,
      detail: {
        user,
        memo: p.memo ?? "",
        item_title: item.title ?? "",
        item_url: item.url ?? null,
        channel: item.channel?.title ?? null,
      },
    });
  }
  return out;
}

// ---- 送る

function keychain(account) {
  try {
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN, "-a", account, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * pawprints は rururu CLI を呼んだ結果（配列）そのまま。null なら「取れなかった」＝
 * rururu-paw の items も replace も足さない（港にある分を消さない）。配列なら（0件でも）replace に入れる
 */
export function buildPayload(date, logText, ambientDir, pawprints) {
  const items = logText === null ? [] : parseVaultLog(logText, date);
  const replace = [];
  // log が読めなかったときは入れ替えない（港の分を空にしない）
  if (logText !== null) replace.push({ source: "vault-log", date });
  const summary = ambientSummary(ambientDir, date);
  if (summary) {
    items.push(summary);
    replace.push({ source: "ambient", date });
  }
  if (Array.isArray(pawprints)) {
    items.push(...parsePawprints(pawprints, date));
    replace.push({ source: "rururu-paw", date });
  }
  return { items, replace };
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const di = args.indexOf("--date");
  const dates = di >= 0 ? [args[di + 1]] : datesToSend(new Date());
  if (!dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? ""))) {
    console.error("--date は YYYY-MM-DD");
    process.exit(2);
  }

  let logText = null;
  try {
    logText = readFileSync(VAULT_LOG, "utf8");
  } catch (e) {
    console.error(`vault の log が読めない（${e.code ?? e.name}）: vault-log は送らない`);
  }

  // rururu CLI は1回だけ呼ぶ（日ごとに呼び直さない）。失敗なら null（rururu-paw は入れ替えない）
  const pawprints = fetchPawprints();
  if (pawprints === null) console.error("rururu の足あとが取れない（CLI 失敗・未ログインなど）: rururu-paw は送らない");

  const headers = { "Content-Type": "application/json" };
  if (!dry) {
    const id = keychain("client-id");
    const secret = keychain("client-secret");
    const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_BASE);
    if (id && secret) {
      headers["CF-Access-Client-Id"] = id;
      headers["CF-Access-Client-Secret"] = secret;
    } else if (!local) {
      console.error(`キーチェーン ${KEYCHAIN} の client-id / client-secret が無い`);
      process.exit(1);
    }
  }

  let failed = false;
  for (const date of dates) {
    const payload = buildPayload(date, logText, AMBIENT_DIR, pawprints);
    const kinds = payload.items.reduce((a, i) => ({ ...a, [i.source]: (a[i.source] ?? 0) + 1 }), {});
    if (!payload.replace.some((r) => r.source === "ambient")) kinds.ambient = "要約なし（送らない）";
    if (!payload.replace.some((r) => r.source === "rururu-paw")) kinds["rururu-paw"] = "取れなかった（送らない）";
    if (dry) {
      console.log(`${date}: ${JSON.stringify(kinds)}`);
      for (const i of payload.items) console.log(`  [${i.source}] ${i.title}`);
      continue;
    }
    try {
      const res = await fetch(`${URL_BASE}/api/ingest`, { method: "POST", headers, body: JSON.stringify(payload), redirect: "manual", signal: AbortSignal.timeout(20_000) });
      const text = await res.text();
      if (!res.ok) {
        failed = true;
        console.error(`${new Date().toISOString()} ${date}: HTTP ${res.status} ${text.slice(0, 200)}`);
      } else {
        console.log(`${new Date().toISOString()} ${date}: ${JSON.stringify(kinds)} → ${text.slice(0, 200)}`);
      }
    } catch (e) {
      failed = true;
      console.error(`${new Date().toISOString()} ${date}: 送れない（${e.name}）`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
