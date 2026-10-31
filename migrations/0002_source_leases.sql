ALTER TABLE poc_sources ADD COLUMN lease_token TEXT;
ALTER TABLE poc_sources ADD COLUMN lease_expires_at TEXT;
ALTER TABLE poc_sources ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_poc_sources_claim ON poc_sources(due_at, lease_expires_at);
