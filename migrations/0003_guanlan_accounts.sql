-- GLN-005: additive account/consumer domain. Public ingestion remains in poc_*.
-- Identity fields are trusted identifiers supplied by future Cloud Auth provisioning,
-- not credentials or user-provided principal claims.
CREATE TABLE guanlan_accounts (
  account_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(account_id) BETWEEN 1 AND 128 AND account_id = trim(account_id)
  ),
  created_at TEXT NOT NULL
);

CREATE TABLE guanlan_consumers (
  account_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL CHECK (
    length(consumer_id) BETWEEN 1 AND 128 AND consumer_id = trim(consumer_id)
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, consumer_id),
  FOREIGN KEY (account_id) REFERENCES guanlan_accounts(account_id) ON DELETE CASCADE
);
CREATE INDEX idx_guanlan_consumers_account ON guanlan_consumers(account_id);

-- A source is stored/crawled once in poc_sources. Account preferences do not
-- override its global scheduler fields in this migration.
CREATE TABLE guanlan_account_subscriptions (
  account_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  interval_hours INTEGER NOT NULL DEFAULT 1 CHECK (interval_hours BETWEEN 1 AND 24),
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, source_id),
  FOREIGN KEY (account_id) REFERENCES guanlan_accounts(account_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES poc_sources(id) ON DELETE RESTRICT
);
CREATE INDEX idx_guanlan_account_subscriptions_source
  ON guanlan_account_subscriptions(source_id);

-- Composite FK is essential: a consumer with the same label under another
-- account does not authorize a cross-tenant subscription.
CREATE TABLE guanlan_consumer_subscriptions (
  account_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  interval_hours INTEGER NOT NULL DEFAULT 1 CHECK (interval_hours BETWEEN 1 AND 24),
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, consumer_id, source_id),
  FOREIGN KEY (account_id, consumer_id)
    REFERENCES guanlan_consumers(account_id, consumer_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES poc_sources(id) ON DELETE RESTRICT
);
CREATE INDEX idx_guanlan_consumer_subscriptions_source
  ON guanlan_consumer_subscriptions(source_id);

-- Account interests are a shared baseline. Consumer interests add to it,
-- never mutate it. Normalized equality is case-insensitive within each owner.
CREATE TABLE guanlan_account_interests (
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('keyword','topic')),
  value TEXT NOT NULL COLLATE NOCASE CHECK (
    length(value) BETWEEN 1 AND 128 AND value = trim(value)
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, kind, value),
  FOREIGN KEY (account_id) REFERENCES guanlan_accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE guanlan_consumer_interests (
  account_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('keyword','topic')),
  value TEXT NOT NULL COLLATE NOCASE CHECK (
    length(value) BETWEEN 1 AND 128 AND value = trim(value)
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, consumer_id, kind, value),
  FOREIGN KEY (account_id, consumer_id)
    REFERENCES guanlan_consumers(account_id, consumer_id) ON DELETE CASCADE
);
