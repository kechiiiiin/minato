# 港（minato）

いろいろな出どころから「その日の材料」を1時間ごとに集めて貯める、**画面を持たない** Cloudflare Worker＋D1。
かけら帳の iPhone アプリが日付で読み、押すとかけらになる。ほかのアプリやヘスティアも同じ港を引ける。

```
src/            Worker（Hono・TypeScript）
  sources/      出どころごとのモジュール（便り・NoBu・からだ帳・Hevy・天気）
migrations/     D1 マイグレーション
scripts/        Access の一回きりの設定 setup-access.sh・Mac から送る send-to-minato.mjs と launchd の雛形
test/           node --test（D1 は node:sqlite のシム）
```

設計: jinsei vault `hestia/projects/blog-cms-design/かけら帳iOS構想.md` §3.1

## 仕組み

| 項目 | どうなっているか |
| --- | --- |
| 材料 | `materials`。`source`・`external_id`・`occurred_at`（+09:00 付き・日単位のものは null）・`date`（JST の YYYY-MM-DD）・`title`・`url`・`detail`（JSON）・`collected_at`。`(source, external_id)` で冪等に upsert |
| 入れ替え | 集めに成功した (出どころ, 日) は「今回のが全部」として、今回来なかった古い行を消す（便りで既読を戻した記事などが残らない）。失敗した出どころの前の材料は消さない |
| 集めた記録 | `collect_log`。いつ・どのきっかけ（cron／manual／ingest）・どの日・どの出どころが ok／skipped／error・何件・理由。30 日で消える |
| cron | 毎時 5 分（`wrangler.toml` の `[triggers]`）。当日分を集め、JST 0〜2時台は前日分も（1回取りこぼしても前日の終わりまで拾える） |
| 秘密が無い出どころ | 外へ出ずに `skipped` にして理由（例「HEVY_API_KEY が未設定」）を残す |
| 上流の呼び方 | Access のサービストークンのヘッダ（`CF-Access-Client-Id`／`-Secret`）。リダイレクトは追わない（Access のログインへ回されたら error「トークンが通っていない」） |
| 認証 | Access のサービストークンだけ。関所（sekisho）の `verify(token, aud, { allowServiceTokens: true })` で確かめ、Client ID を `ACCESS_SERVICE_CLIENT_IDS` と照合。トークン無し・設定漏れ・関所の故障は 401、allowlist 外とブラウザのユーザーは 403、allowlist が空なら1本も通さない（fail-closed） |

## 出どころ

| source | 何 | どこから | 要るもの |
| --- | --- | --- | --- |
| `tayori` | 便りで既読にした記事 | `GET {TAYORI_URL}/api/items/read-on?date=` | `TAYORI_URL`（vars）・`TAYORI_CLIENT_ID`／`TAYORI_CLIENT_SECRET` |
| `nobu` | NoBu の状態の変化（時刻あり）と読んだ日（日単位） | `GET {NOBU_URL}/api/timeline`（新しい順にページングして、その日の分） | `NOBU_URL`（vars）・`NOBU_CLIENT_ID`／`NOBU_CLIENT_SECRET` |
| `health` | からだ帳のその日の記録（歩数など・睡眠）と食事・ひとこと | `GET {HEALTH_URL}/v1/app/day/:date`・`/v1/app/meals?from=&to=` | `HEALTH_URL`（vars）・`HEALTH_CLIENT_ID`／`HEALTH_CLIENT_SECRET` |
| `hevy` | Hevy のワークアウト | `GET https://api.hevyapp.com/v1/workouts`（ヘッダ `api-key`） | `HEVY_API_KEY`（Hevy Pro で発行） |
| `weather` | その日の天気・最高／最低気温・降水量 | Open-Meteo（鍵不要。60 日より前は archive-api） | `WEATHER_LATITUDE`／`WEATHER_LONGITUDE`（座標はリポジトリに書かない・材料にも入れない） |
| `vault-log` | jinsei vault の log の見出し（`## YYYY-MM-DD \| 種別 \| タイトル`）と本文の先頭 | Mac から `POST /api/ingest` | Mac のキーチェーン `kakera-token` |
| `ambient` | Ambient Context のその日の要約（`~/ambient-context/Summaries/YYYY-MM-DD.md`） | Mac から `POST /api/ingest` | 同上 |
| `rururu-paw` | rururu の「自分のチャンネルへの足あと」（pawprints to_me） | rururu CLI（`~/.local/bin/rururu`）を Mac から `POST /api/ingest` | 同上（CLI が `rururu auth login` 済みであること。失敗時は送らない） |

### 作っていないもの

- **Amazon の購入（Notion）** — GAS が書く先の Notion DB は空（vault の記録）。カード照合の正本も Gmail と Moneytree で、Notion は使っていない
- **カードの利用（Notion）** — Notion へ書くのは Discord Bot で、`logs/bot.log` の最後の保存が 2026-07-07（GAS の利用通知が止まっている）。いまの正本は Moneytree（ブラウザの中）で、Worker から読む口が無い
- **Google カレンダー** — Worker から通すには OAuth（Google Cloud のプロジェクト・同意画面・更新トークンの保管と失効の手当て）が要る。鍵1本で済む形は「非公開の iCal アドレス」だが、繰り返し予定の展開（RRULE・例外日）を自前で持つことになるので見送り

## API

すべて Access の裏（サービストークン）。

| メソッド | パス | 本文・クエリ → 応答 |
| --- | --- | --- |
| GET | `/api/materials?date=YYYY-MM-DD` | → `{ date, groups: [{ source, label, count, items: [{ id, source, external_id, occurred_at, date, title, url, detail, collected_at }] }], status: [{ source, label, status, count, reason, run_at, trigger }] }`。`groups` は出どころ順、中は時刻順（時刻の無いものは後ろ）。`status` は出どころごとのその日の最後の集め。日付が不正なら 400 `bad_date` |
| POST | `/api/collect` | `{ date? }`（またはクエリ `?date=`。省略は JST の今日）→ `{ date, run_at, trigger: "manual", results: [{ source, label, date, status, count, reason }] }`。Mac から送るもの（vault-log・ambient）は次の送り出しを待つ |
| POST | `/api/ingest` | `{ items: [{ source, external_id, date, occurred_at?, title, url?, detail? }], replace?: [{ source, date }] }` → `{ accepted, replaced }`。`source` は `vault-log`／`ambient`／`rururu-paw` だけ（cron の出どころは上書きさせない）。`replace` に挙げた (source, date) は送ったものがその日の全部として古い行を消す（0 件なら空にする）。1件でも不正なら何も入れず 400（`bad_source`・`bad_date`・`bad_occurred_at`（オフセットの無い日時は不可）・`bad_title`・`bad_url`・`bad_detail`・`detail_too_large`（64KB）・`too_many_items`（500 件）…） |

## secret と vars

| 名前 | 種類 | 値の出どころ |
| --- | --- | --- |
| `CF_ACCESS_AUD` | secret | Access アプリ `minato` の AUD |
| `ACCESS_SERVICE_CLIENT_IDS` | secret | 港を呼べるサービストークンの Client ID（カンマ区切り）。かけら帳と Mac は `kakera-ios` |
| `TAYORI_URL` | vars | `https://tayori.kechiiiiin.com`（`wrangler.toml`） |
| `TAYORI_CLIENT_ID`／`TAYORI_CLIENT_SECRET` | secret | `kakera-ios`（キーチェーン `kakera-token`。便りのポリシーと allowlist には `scripts/setup-access.sh` が足す） |
| `NOBU_URL` | vars | `https://nobu.kechiiiiin.com` |
| `NOBU_CLIENT_ID`／`NOBU_CLIENT_SECRET` | secret | `kakera-ios`（NoBu のポリシーと allowlist には `scripts/setup-access.sh` が足す） |
| `HEALTH_URL` | vars | `https://health.kechiiiiin.com` |
| `HEALTH_CLIENT_ID`／`HEALTH_CLIENT_SECRET` | secret | health-sync のヘスティア役のトークン（キーチェーン `health-sync-hestia-token`）。health-sync-cloud は `INGEST_CLIENT_ID`／`HESTIA_CLIENT_ID` の2本しか通さず、`/v1/app/day` はヘスティア役だけ |
| `WEATHER_LATITUDE`／`WEATHER_LONGITUDE` | secret | 天気を引く場所（小数の度） |
| `HEVY_API_KEY` | secret | Hevy の設定 → API（Hevy Pro） |

欠けている出どころは黙ってスキップする（`/api/collect` と `/api/materials` の `status` に理由が出る）。

## 本番に出す

【Keisuke・ターミナル】は1回（`scripts/setup-access.sh`。自動モードではキーチェーンと Access の変更が止まるため）。【Keisuke・ブラウザ】は無し（Hevy の鍵を使うときだけ Hevy の画面で1回発行）。

1. 【ヘスティア・コマンド】`wrangler d1 create minato` → `wrangler.toml` の `database_id` を差し替え → `wrangler d1 migrations apply minato --remote` → `wrangler deploy`（Custom Domain `minato.kechiiiiin.com` は deploy で DNS ごとできる。secret が入るまでは全部 401 で閉じている）
2. 【Keisuke・ターミナル・1回】`bash scripts/setup-access.sh`
   - サービストークン `kakera-ios` を用意（キーチェーン `kakera-token` に `client-id`／`client-secret` が揃っていれば回し直さない）
   - Access アプリ（かけら帳・便り・NoBu）のポリシーに `kakera-ios` を**足す**（既存の許可は消さない。便り・NoBu は既存トークンの Service Auth ポリシーに足し、かけら帳は Google ログインのポリシーとは別に Service Auth のポリシーを足す）
   - Access アプリ `minato`（Self-hosted）を無ければ作り、Service Auth で `kakera-ios` だけ通す
   - Worker secret: かけら帳・便り・NoBu の `ACCESS_SERVICE_CLIENT_IDS`（便り・NoBu は Access が通すトークン全部＝既存＋`kakera-ios`）、港の `CF_ACCESS_AUD`・`ACCESS_SERVICE_CLIENT_IDS`・`TAYORI_*`・`NOBU_*`（`kakera-ios`）・`HEALTH_*`（キーチェーン `health-sync-hestia-token`）・`WEATHER_*`（キーチェーン `minato-weather` の `latitude`／`longitude` があれば）
   - 何度流しても同じ結果。**港の Worker がまだ無いと港の secret だけ飛ばして案内を出す**ので、1. の deploy の後に流す（先に流してしまったら deploy の後にもう一度）
3. 【ヘスティア・コマンド】確かめる: トークン無しで 403/302（Access）、トークン付きで `POST /api/collect` → 各出どころの `status`、`GET /api/materials?date=今日`
4. 使うなら `HEVY_API_KEY` を `wrangler secret put`

⚠️ 便りの `scripts/setup-access.sh` をもう一度流すと、便りのポリシーと `ACCESS_SERVICE_CLIENT_IDS` が `tayori-app` だけに戻り、`kakera-ios` が外れる（かけら帳 iOS と港から便りが読めなくなる）。そのときはこのスクリプトをもう一度流す。

⚠️ 港から便り・NoBu・からだ帳へは、同じゾーンの Custom Domain を Worker の `fetch` で呼ぶ。Access の前を通るので、サービストークンが各 Access アプリのポリシーに入っていないと 302/403 で `error` になる（理由に出る）。

## Mac 側（vault の log・Ambient Context の要約・rururu の足あとを送る）

```sh
node scripts/send-to-minato.mjs --dry-run        # 送らずに、今日送る見出しを表示
node scripts/send-to-minato.mjs                  # 今日（JST 0〜2時台は前日も）を送る
node scripts/send-to-minato.mjs --date 2026-11-23
```

- トークンはキーチェーン `kakera-token` の `client-id`／`client-secret`（かけら帳と同じ）。値は表示しない
- 送るたびに「その日の全部」として入れ替える（log から消した見出しは港からも消える）。log が読めなかったときは入れ替えない
- Ambient Context の要約（`Summaries/YYYY-MM-DD.md`）が無い日は ambient を送らない（要約は Ambient Context の `summarise_day` で作られる）
- rururu の足あとは `rururu` CLI（既定 `~/.local/bin/rururu`・`MINATO_RURURU` で差し替え）を1回だけ呼び、`pawprints list --scope to_me` の JST の日ごとに振り分ける。CLI が失敗（未ログイン・sandbox など）したときは rururu-paw を入れ替えない（港にある分を消さない）
- 環境変数で差し替え: `MINATO_URL`・`MINATO_VAULT_LOG`・`MINATO_AMBIENT_DIR`・`MINATO_KEYCHAIN`

launchd に入れる（毎時 10 分・ログは `~/Library/Logs/minato-send.log`）:

```sh
sed -e "s|__NODE__|$(nodenv which node)|" -e "s|__REPO__|$PWD|" -e "s|__HOME__|$HOME|" \
  scripts/jp.kechiiiiin.minato-send.plist > ~/Library/LaunchAgents/jp.kechiiiiin.minato-send.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/jp.kechiiiiin.minato-send.plist
# 止める: launchctl bootout gui/$(id -u)/jp.kechiiiiin.minato-send
```

## 開発

```sh
npm install
npm run check          # tsc --noEmit と テスト

cp .dev.vars.example .dev.vars   # ローカルは認証を迂回（localhost かつ --define __LOCAL_DEV__ のときだけ）
npm run dev            # http://127.0.0.1:8793
curl -X POST http://127.0.0.1:8793/api/collect
MINATO_URL=http://127.0.0.1:8793 node scripts/send-to-minato.mjs
```

ローカルの迂回は三重ガード（ビルド時定数 `__LOCAL_DEV__`・`DEV_BYPASS_AUTH=1`・ホストが localhost / 127.0.0.1）。`DEV_BYPASS_AUTH` を `wrangler.toml` の `[vars]` に書かない。
