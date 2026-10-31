-- GLN-001: isolated, temporary data model; not a production subscription schema.
CREATE TABLE IF NOT EXISTS poc_sources (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  interval_hours INTEGER NOT NULL DEFAULT 1 CHECK (interval_hours BETWEEN 1 AND 24),
  due_at TEXT NOT NULL,
  last_status TEXT,
  last_error TEXT,
  last_checked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_poc_sources_due ON poc_sources(due_at);
CREATE TABLE IF NOT EXISTS poc_news (
  url TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES poc_sources(id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  ingested_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_poc_news_ingested ON poc_news(ingested_at DESC);
