-- schema 由 scripts/migrate.js 套用（npm run db:migrate），不在每次請求裡自動建表
-- 這份檔案也能直接貼到 Neon SQL Editor、或 psql 對 RDS 執行

CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RDS 上 pgvector 通常要手動開擴（Neon 預設可用）
-- CREATE EXTENSION IF NOT EXISTS vector;

-- CREATE TABLE IF NOT EXISTS docs (
--   id BIGSERIAL PRIMARY KEY,
--   content TEXT,
--   embedding vector(1024),
--   created_at TIMESTAMPTZ NOT NULL DEFAULT now()
-- );
