-- 港（minato）: その日の材料と、集めた記録

-- 材料。(source, external_id) で冪等に upsert する
CREATE TABLE materials (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 出どころ（tayori / nobu / health / weather / hevy / vault-log / ambient …）
  source       TEXT NOT NULL,
  -- 出どころの中での一意な鍵（記事 id・イベント id・日付など）
  external_id  TEXT NOT NULL,
  -- いつのことか。ISO8601・+09:00 付き（例 2026-11-23T08:15:00+09:00）。時刻の無いもの（日単位）は NULL
  occurred_at  TEXT,
  -- JST の日付 YYYY-MM-DD（かけら帳はこれで引く）
  date         TEXT NOT NULL,
  title        TEXT NOT NULL,
  url          TEXT,
  -- 出どころごとの中身（JSON オブジェクト）
  detail       TEXT NOT NULL DEFAULT '{}',
  -- 最後に集めた（入れ直した）時刻（UTC の ISO8601）
  collected_at TEXT NOT NULL,
  UNIQUE (source, external_id)
);
CREATE INDEX materials_by_date ON materials (date, source, occurred_at);

-- 集めた記録。1回の集め（cron／手動／Mac からの受け取り）の、出どころ1つにつき1行
CREATE TABLE collect_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 集めた時刻（UTC の ISO8601）
  run_at    TEXT NOT NULL,
  -- cron / manual / ingest
  trigger   TEXT NOT NULL,
  -- どの日の分か（JST の YYYY-MM-DD）
  date      TEXT NOT NULL,
  source    TEXT NOT NULL,
  -- ok / skipped / error
  status    TEXT NOT NULL,
  -- 入れた（入れ直した）件数
  count     INTEGER NOT NULL DEFAULT 0,
  -- スキップ・失敗の理由（ok なら NULL）
  reason    TEXT
);
CREATE INDEX collect_log_by_run ON collect_log (run_at);
