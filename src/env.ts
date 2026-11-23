import type { Sekisho } from "./auth.ts";

export interface Env {
  DB: D1Database;

  // ---- 港そのものの認証（Access のサービストークン。JWT の検証は関所 sekisho に聞く・auth.ts） ----
  /** 関所への Service Binding。未設定なら全員 401 */
  SEKISHO?: Sekisho;
  /** Access アプリ minato の AUD タグ（secret）。空なら全員 401 */
  CF_ACCESS_AUD?: string;
  /** 通すサービストークンの Client ID（カンマ区切り・secret）。**空なら1本も通さない** */
  ACCESS_SERVICE_CLIENT_IDS?: string;

  // ---- 出どころ。URL は vars、トークン・座標・鍵は secret。欠けている出どころは黙ってスキップ ----
  /** 便りの本番ホスト（vars・例 https://tayori.kechiiiiin.com） */
  TAYORI_URL?: string;
  /** 便りへ付ける Access サービストークン（secret。かけら帳と同じ kakera-ios でよい） */
  TAYORI_CLIENT_ID?: string;
  TAYORI_CLIENT_SECRET?: string;

  /** NoBu の本番ホスト（vars） */
  NOBU_URL?: string;
  /** NoBu へ付ける Access サービストークン（secret。NoBu の ACCESS_SERVICE_CLIENT_IDS に載っているもの） */
  NOBU_CLIENT_ID?: string;
  NOBU_CLIENT_SECRET?: string;

  /** からだ帳（health-sync-cloud）の本番ホスト（vars） */
  HEALTH_URL?: string;
  /** からだ帳へ付ける Access サービストークン（secret。health-sync-cloud の HESTIA_CLIENT_ID のもの＝ /v1/app/day を読める役） */
  HEALTH_CLIENT_ID?: string;
  HEALTH_CLIENT_SECRET?: string;

  /** 天気を引く場所（secret。リポジトリに座標を書かない） */
  WEATHER_LATITUDE?: string;
  WEATHER_LONGITUDE?: string;

  /** Hevy の API キー（secret。Hevy Pro の設定画面で発行） */
  HEVY_API_KEY?: string;

  /** ローカル開発の迂回。ビルド時定数と localhost が揃わないと効かない（auth.ts） */
  DEV_BYPASS_AUTH?: string;
}

export type AppEnv = { Bindings: Env; Variables: { principal: string } };
