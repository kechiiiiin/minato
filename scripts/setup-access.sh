#!/bin/bash
# かけら帳 iOS と港（minato）を本番に出すための、Cloudflare Access の一回きりの設定。
# 秘密の値は画面に出さず、キーチェーンにだけ置く。何度流しても同じ結果になる
# （kakera-ios はキーチェーンに client-id / client-secret が揃っていれば回し直さない）。
#
#   1. サービストークン kakera-ios を用意する → キーチェーン kakera-token（client-id / client-secret）
#        無ければ作る。あってもキーチェーンに秘密が無い（または client-id が食い違う）ときだけ回し直す
#   2. 既存の Access アプリのポリシーに kakera-ios を「足す」（既存の許可は消さない・置き換えない）
#        kakera.kechiiiiin.com  … Google ログインのポリシーはそのまま、Service Auth のポリシーを別に足す
#        tayori.kechiiiiin.com  … tayori-app が入っている Service Auth のポリシーに足す
#        nobu.kechiiiiin.com    … nobu-ios が入っている Service Auth のポリシーに足す
#        （そのポリシーが再利用ポリシー＝他のアプリと共有のときは触らず、このアプリ専用のポリシーを別に足す）
#   3. Access アプリ minato（minato.kechiiiiin.com・Self-hosted）を無ければ作り、Service Auth で kakera-ios を通す
#   4. Worker secret を入れる（値は標準入力で渡し、画面に出さない）
#        kakera-cho  ACCESS_SERVICE_CLIENT_IDS = kakera-ios
#        tayori/nobu ACCESS_SERVICE_CLIENT_IDS = そのアプリの Service Auth が通すトークン全部（既存＋kakera-ios）
#        minato      CF_ACCESS_AUD・ACCESS_SERVICE_CLIENT_IDS・TAYORI_*・NOBU_*（kakera-ios）
#                    HEALTH_*（キーチェーン health-sync-hestia-token）
#                    WEATHER_LATITUDE / WEATHER_LONGITUDE（キーチェーン minato-weather にあれば）
#   5. したこと・飛ばしたことを一覧にする（秘密の値は出さない）
#
# 流す順番: minato の Worker が Cloudflare にまだ無いと secret を入れられない。
#   ヘスティアが D1 作成・マイグレーション・wrangler deploy を済ませてから流すのが一番素直。
#   先に流しても壊れない（minato の secret だけ飛ばして最後に案内を出す）。deploy の後にもう一度流せば揃う。
#
# 要るもの: キーチェーン cloudflare-admin-token（Access 編集）・cloudflare-deploy-token（Workers 編集）
#           ~/work に kakera-cho・tayori・nobu・minato があり、それぞれ npm install 済みであること
# ⚠️ tayori の scripts/setup-access.sh をもう一度流すと、便りのポリシーと ACCESS_SERVICE_CLIENT_IDS が
#    tayori-app だけに戻り kakera-ios が外れる。そのときはこのスクリプトをもう一度流す。
set -euo pipefail

TOKEN_NAME=kakera-ios
KC=kakera-token
POLICY_NAME="kakera-ios service token"
WORK=${WORK:-$(cd "$(dirname "$0")/../.." && pwd)}

KAKERA_HOST=kakera.kechiiiiin.com
TAYORI_HOST=tayori.kechiiiiin.com
NOBU_HOST=nobu.kechiiiiin.com
MINATO_HOST=minato.kechiiiiin.com
TAYORI_TOKEN=tayori-app
NOBU_TOKEN=nobu-ios
HEALTH_KC=health-sync-hestia-token
WEATHER_KC=minato-weather

KAKERA_DIR=$WORK/kakera-cho
TAYORI_DIR=$WORK/tayori/worker
NOBU_DIR=$WORK/nobu
MINATO_DIR=$WORK/minato

for d in "$KAKERA_DIR" "$TAYORI_DIR" "$NOBU_DIR" "$MINATO_DIR"; do
  [ -f "$d/wrangler.toml" ] || { echo "❌ $d/wrangler.toml が無い" >&2; exit 1; }
done

DONE_LOG=""
SKIP_LOG=""
did() { DONE_LOG+="  - $1"$'\n'; echo "✓ $1"; }
skipped() { SKIP_LOG+="  - $1"$'\n'; echo "… $1"; }

ADMIN=$(security find-generic-password -s cloudflare-admin-token -w)
DEPLOY=$(security find-generic-password -s cloudflare-deploy-token -w)
api() { curl -sS -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" "$@"; }
ok() { python3 -c 'import sys,json;d=json.load(sys.stdin);sys.exit(0 if d.get("success") else (print(d.get("errors"),file=sys.stderr) or 1))'; }
field() { python3 -c "import sys,json;print(json.load(sys.stdin)['result']['$1'])"; }
has_kc() { security find-generic-password -s "$1" -a "$2" >/dev/null 2>&1; }
kc_value() { security find-generic-password -s "$1" -a "$2" -w | tr -d '\n'; }
# 値は標準入力から（画面に出さない）。各リポジトリの wrangler と wrangler.toml を使う
put_secret() { (cd "$1" && CLOUDFLARE_API_TOKEN=$DEPLOY npx wrangler secret put "$2" >/dev/null); }

ACC=$(api "https://api.cloudflare.com/client/v4/zones?name=kechiiiiin.com" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"][0]["account"]["id"])')
B=https://api.cloudflare.com/client/v4/accounts/$ACC/access

tokens_json() { local r; r=$(api "$B/service_tokens?per_page=1000"); echo "$r" | ok; echo "$r"; }
# トークン名 → 指定の欄（無ければ空）
token_field() {
  echo "$1" | N="$2" F="$3" python3 -c 'import os,sys,json
print(next((t[os.environ["F"]] for t in json.load(sys.stdin)["result"] if t["name"]==os.environ["N"]),""))'
}

# ---------------------------------------------------------------- 1. kakera-ios
TOKS=$(tokens_json)
KID=$(token_field "$TOKS" "$TOKEN_NAME" id)
REMOTE_CID=$(token_field "$TOKS" "$TOKEN_NAME" client_id)
LOCAL_CID=$( (security find-generic-password -s "$KC" -a client-id -w 2>/dev/null || true) | tr -d '\n')

if [ -n "$KID" ] && [ -n "$LOCAL_CID" ] && [ "$LOCAL_CID" = "$REMOTE_CID" ] && has_kc "$KC" client-secret; then
  KCID=$REMOTE_CID
  skipped "トークン $TOKEN_NAME は既にあり、キーチェーン $KC も揃っているので回し直さない"
else
  if [ -z "$KID" ]; then
    R=$(api -X POST "$B/service_tokens" -d "{\"name\":\"$TOKEN_NAME\",\"duration\":\"forever\"}")
    WHAT="作った"
  else
    # 秘密は読み戻せない（作ったとき・回したときだけ返る）ので、キーチェーンに無ければ回し直すしかない
    R=$(api -X POST "$B/service_tokens/$KID/rotate")
    WHAT="回し直した（キーチェーン $KC に秘密が無い／client-id が食い違っていたため。古い秘密を埋め込んだアプリは通らなくなる）"
  fi
  echo "$R" | ok
  KID=$(echo "$R" | field id)
  KCID=$(echo "$R" | field client_id)
  security add-generic-password -U -s "$KC" -a client-id -w "$KCID"
  security add-generic-password -U -s "$KC" -a client-secret -w "$(echo "$R" | field client_secret)"
  unset R
  did "トークン $TOKEN_NAME を${WHAT}→ キーチェーン $KC に保存"
fi

# ---------------------------------------------------------------- 2・3. Access アプリのポリシー
APPS=$(api "$B/apps?per_page=1000")
echo "$APPS" | ok
REUSABLE=$(api "$B/policies?per_page=1000")
echo "$REUSABLE" | ok

# ホスト（domain の完全一致）→ アプリの id（無ければ空・2つ以上なら止まる）
app_id_by_host() {
  echo "$APPS" | H="$1" python3 -c 'import os,sys,json
h=os.environ["H"]
m=[a for a in json.load(sys.stdin)["result"] if (a.get("domain") or "").rstrip("/")==h]
if len(m)>1:
    print("❌ %s を守るアプリが複数ある: %s" % (h, [a.get("name") for a in m]), file=sys.stderr); sys.exit(1)
print(m[0]["id"] if m else "")'
}
app_field() { echo "$APPS" | I="$1" F="$2" python3 -c 'import os,sys,json
print(next((a.get(os.environ["F"]) or "" for a in json.load(sys.stdin)["result"] if a["id"]==os.environ["I"]),""))'; }

# アプリに kakera-ios を足す計画を立てる。出力は3行: skip|put|post / 直すポリシーの id / 送る本文
#   既に入っている → skip
#   OLD_TID（既存トークン）が入っている、このアプリ専用（再利用でない）の Service Auth ポリシーがある
#     → そのポリシーを読み、include に足した配列で PUT（ほかの欄はそのまま送り返す）
#   それ以外 → kakera-ios だけの Service Auth ポリシーを新しく POST（precedence は今の最大＋1）
plan_policy() {
  local pol
  pol=$(api "$B/apps/$1/policies?per_page=1000")
  echo "$pol" | ok
  POL=$pol REU=$REUSABLE NEW_TID=$KID OLD_TID=$2 NAME=$POLICY_NAME python3 -c 'import os,json
pol=json.loads(os.environ["POL"]).get("result") or []
reu={p["id"] for p in (json.loads(os.environ["REU"]).get("result") or [])}
new,old=os.environ["NEW_TID"],os.environ["OLD_TID"]
def tids(p): return [r["service_token"]["token_id"] for r in (p.get("include") or []) if isinstance(r,dict) and "service_token" in r]
if any(new in tids(p) for p in pol):
    print("skip"); print("-"); print("-"); raise SystemExit
WRITABLE=["name","decision","precedence","include","exclude","require","approval_groups","approval_required",
          "isolation_required","purpose_justification_required","purpose_justification_prompt","session_duration",
          "mfa_config","connection_rules"]
t=next((p for p in pol if old and p["id"] not in reu and p.get("decision")=="non_identity" and old in tids(p)),None)
if t:
    body={k:t[k] for k in WRITABLE if t.get(k) is not None}
    body["include"]=list(t.get("include") or [])+[{"service_token":{"token_id":new}}]
    print("put"); print(t["id"]); print(json.dumps(body))
else:
    prec=max([int(p.get("precedence") or 0) for p in pol]+[0])+1
    body={"name":os.environ["NAME"],"decision":"non_identity","precedence":prec,"include":[{"service_token":{"token_id":new}}]}
    print("post"); print("-"); print(json.dumps(body))'
}

# $1 アプリ id・$2 既存トークン id（無ければ空）・$3 表示名
add_to_app() {
  local plan act pid body
  plan=$(plan_policy "$1" "$2")
  { read -r act; read -r pid; read -r body; } <<<"$plan"
  case $act in
    skip) skipped "$3: $TOKEN_NAME は既にポリシーに入っている" ;;
    put)  api -X PUT "$B/apps/$1/policies/$pid" -d "$body" | ok
          did "$3: 既存の Service Auth ポリシーに $TOKEN_NAME を足した（ほかの許可はそのまま）" ;;
    post) api -X POST "$B/apps/$1/policies" -d "$body" | ok
          if [ -n "$2" ]; then
            did "$3: 既存トークンのポリシーが共有（再利用）か見つからないため、$TOKEN_NAME だけの Service Auth ポリシーを別に足した"
          else
            did "$3: $TOKEN_NAME だけの Service Auth ポリシーを足した（ほかの許可はそのまま）"
          fi ;;
  esac
}

# アプリの Service Auth（non_identity）ポリシーが通すトークンの client_id をカンマ区切りで（$2 の名前のトークンは必ず含める）
client_ids_for_app() {
  local pol toks
  pol=$(api "$B/apps/$1/policies?per_page=1000"); echo "$pol" | ok
  toks=$(tokens_json)
  POL=$pol TOKS=$toks MUST=$2 python3 -c 'import os,json
pol=json.loads(os.environ["POL"]).get("result") or []
toks=json.loads(os.environ["TOKS"])["result"]
ids={r["service_token"]["token_id"] for p in pol if p.get("decision")=="non_identity"
     for r in (p.get("include") or []) if isinstance(r,dict) and "service_token" in r}
cids=[t["client_id"] for t in toks if t["id"] in ids or t["name"]==os.environ["MUST"]]
print(",".join(sorted(set(cids))))'
}

KAKERA_APP=$(app_id_by_host "$KAKERA_HOST")
TAYORI_APP=$(app_id_by_host "$TAYORI_HOST")
NOBU_APP=$(app_id_by_host "$NOBU_HOST")
for pair in "$KAKERA_HOST:$KAKERA_APP" "$TAYORI_HOST:$TAYORI_APP" "$NOBU_HOST:$NOBU_APP"; do
  [ -n "${pair#*:}" ] || { echo "❌ ${pair%%:*} を守る Access アプリが見つからない" >&2; exit 1; }
done
TAYORI_TID=$(token_field "$TOKS" "$TAYORI_TOKEN" id)
NOBU_TID=$(token_field "$TOKS" "$NOBU_TOKEN" id)
[ -n "$TAYORI_TID" ] || { echo "❌ サービストークン $TAYORI_TOKEN が見つからない" >&2; exit 1; }
[ -n "$NOBU_TID" ] || { echo "❌ サービストークン $NOBU_TOKEN が見つからない" >&2; exit 1; }

add_to_app "$KAKERA_APP" "" "かけら帳（$(app_field "$KAKERA_APP" name)・$KAKERA_HOST）"
add_to_app "$TAYORI_APP" "$TAYORI_TID" "便り（$(app_field "$TAYORI_APP" name)・$TAYORI_HOST）"
add_to_app "$NOBU_APP" "$NOBU_TID" "NoBu（$(app_field "$NOBU_APP" name)・$NOBU_HOST）"

# 3. minato のアプリ
MINATO_APP=$(app_id_by_host "$MINATO_HOST")
if [ -z "$MINATO_APP" ]; then
  R=$(api -X POST "$B/apps" -d "{\"name\":\"minato\",\"type\":\"self_hosted\",\"domain\":\"$MINATO_HOST\",\"destinations\":[{\"type\":\"public\",\"uri\":\"$MINATO_HOST\"}],\"session_duration\":\"24h\",\"app_launcher_visible\":false}")
  echo "$R" | ok
  MINATO_APP=$(echo "$R" | field id)
  MINATO_AUD=$(echo "$R" | field aud)
  did "Access アプリ minato（$MINATO_HOST・Self-hosted）を作った"
else
  MINATO_AUD=$(app_field "$MINATO_APP" aud)
  skipped "Access アプリ $(app_field "$MINATO_APP" name)（$MINATO_HOST）は既にあるので作らない"
fi
add_to_app "$MINATO_APP" "" "港（minato・$MINATO_HOST）"
OTHERS=$(api "$B/apps/$MINATO_APP/policies?per_page=1000" | TID=$KID python3 -c 'import os,sys,json
r=json.load(sys.stdin).get("result") or []
print(", ".join(p.get("name","?") for p in r if not any(isinstance(x,dict) and x.get("service_token",{}).get("token_id")==os.environ["TID"] for x in (p.get("include") or []))))')
[ -z "$OTHERS" ] || skipped "港のアプリに kakera-ios 以外のポリシーがある（消していない）: $OTHERS"

# ---------------------------------------------------------------- 4. Worker secret
printf '%s' "$KCID" | put_secret "$KAKERA_DIR" ACCESS_SERVICE_CLIENT_IDS
did "kakera-cho: ACCESS_SERVICE_CLIENT_IDS = $TOKEN_NAME"

IDS=$(client_ids_for_app "$TAYORI_APP" "$TAYORI_TOKEN")
printf '%s' "$IDS" | put_secret "$TAYORI_DIR" ACCESS_SERVICE_CLIENT_IDS
did "tayori: ACCESS_SERVICE_CLIENT_IDS = $(echo "$IDS" | tr ',' '\n' | grep -c .) 本（$TAYORI_TOKEN・$TOKEN_NAME ほか、Access が通すトークン全部）"

IDS=$(client_ids_for_app "$NOBU_APP" "$NOBU_TOKEN")
printf '%s' "$IDS" | put_secret "$NOBU_DIR" ACCESS_SERVICE_CLIENT_IDS
did "nobu: ACCESS_SERVICE_CLIENT_IDS = $(echo "$IDS" | tr ',' '\n' | grep -c .) 本（$NOBU_TOKEN・$TOKEN_NAME ほか、Access が通すトークン全部）"

MINATO_LIVE=$(curl -sS -H "Authorization: Bearer $DEPLOY" "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("yes" if any(s.get("id")=="minato" for s in (d.get("result") or [])) else "no")')
if [ "$MINATO_LIVE" != yes ]; then
  skipped "minato の Worker がまだ無いので、minato の secret は入れていない → deploy の後にこのスクリプトをもう一度流す"
else
  printf '%s' "$MINATO_AUD" | put_secret "$MINATO_DIR" CF_ACCESS_AUD
  printf '%s' "$KCID" | put_secret "$MINATO_DIR" ACCESS_SERVICE_CLIENT_IDS
  printf '%s' "$KCID" | put_secret "$MINATO_DIR" TAYORI_CLIENT_ID
  kc_value "$KC" client-secret | put_secret "$MINATO_DIR" TAYORI_CLIENT_SECRET
  printf '%s' "$KCID" | put_secret "$MINATO_DIR" NOBU_CLIENT_ID
  kc_value "$KC" client-secret | put_secret "$MINATO_DIR" NOBU_CLIENT_SECRET
  did "minato: CF_ACCESS_AUD・ACCESS_SERVICE_CLIENT_IDS・TAYORI_CLIENT_ID/SECRET・NOBU_CLIENT_ID/SECRET（$TOKEN_NAME）"

  if has_kc "$HEALTH_KC" client-id && has_kc "$HEALTH_KC" client-secret; then
    kc_value "$HEALTH_KC" client-id | put_secret "$MINATO_DIR" HEALTH_CLIENT_ID
    kc_value "$HEALTH_KC" client-secret | put_secret "$MINATO_DIR" HEALTH_CLIENT_SECRET
    did "minato: HEALTH_CLIENT_ID/SECRET（キーチェーン $HEALTH_KC）"
  else
    skipped "minato: キーチェーン $HEALTH_KC が無いので HEALTH_* は入れていない（~/work/health-sync-cloud/scripts/setup-hestia-access.sh で作る）"
  fi

  if has_kc "$WEATHER_KC" latitude && has_kc "$WEATHER_KC" longitude; then
    kc_value "$WEATHER_KC" latitude | put_secret "$MINATO_DIR" WEATHER_LATITUDE
    kc_value "$WEATHER_KC" longitude | put_secret "$MINATO_DIR" WEATHER_LONGITUDE
    did "minato: WEATHER_LATITUDE/LONGITUDE（キーチェーン $WEATHER_KC）"
  else
    skipped "minato: 天気の座標が無いので WEATHER_* は入れていない。入れるなら次の2行を流してから、このスクリプトをもう一度:
      security add-generic-password -U -s $WEATHER_KC -a latitude -w     # 緯度（小数の度）をプロンプトで
      security add-generic-password -U -s $WEATHER_KC -a longitude -w    # 経度"
  fi
fi

# ---------------------------------------------------------------- 5. 一覧
echo
echo "== したこと"
printf '%s' "${DONE_LOG:-  （なし）
}"
echo "== 飛ばしたこと・案内"
printf '%s' "${SKIP_LOG:-  （なし）
}"
echo "完了（秘密の値はキーチェーンと Worker secret にだけ置いた）"
