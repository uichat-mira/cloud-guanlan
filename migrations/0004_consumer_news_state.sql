-- GLN-007: per account 脳 stable consumer 脳 canonical-news-URL decision ledger.
--
-- Identity is a deterministic SHA-256 fingerprint of the canonical article URL
-- already stored in `poc_news.url`. No title, summary, body or raw URL is kept
-- here, so a 90-day news-index purge cannot leak article content from this table.
--
-- Deliberately NO foreign key to `poc_news`: the shared news index is global and
-- disposable, while a consumer's decision memory must survive its cleanup. The
-- only FK binds the row to a consumer that actually exists under that account.
--
-- `unread` is the absence of a row. There is no default row and no `unread`
-- status value: reading a decision never creates one.
CREATE TABLE guanlan_consumer_news_states (
  account_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  news_fingerprint TEXT NOT NULL CHECK (
    length(news_fingerprint) = 64
    AND news_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  -- Source under which the decision was authorized. Kept so a decision can be
  -- re-read under the consumer's current permission set after the news row is
  -- purged. It never re-authorizes an unsubscribed source by itself.
  -- Mirrors `poc_sources.id`: no length/trim bound, only non-empty.
  source_id TEXT NOT NULL CHECK (length(source_id) >= 1),
  status TEXT NOT NULL CHECK (status IN ('pending', 'adopted', 'ignored')),
  -- Bounded decision context. `trim` equality keeps stored values canonical.
  reason TEXT CHECK (
    reason IS NULL OR (length(reason) BETWEEN 1 AND 500 AND reason = trim(reason))
  ),
  outcome_url TEXT CHECK (
    outcome_url IS NULL OR (length(outcome_url) BETWEEN 1 AND 2048 AND outcome_url = trim(outcome_url))
  ),
  decided_at TEXT NOT NULL CHECK (length(decided_at) BETWEEN 1 AND 64),
  -- Monotonic per-row version. Ordering authority is this integer, never a
  -- client clock: every explicit write must name the version it expects.
  version INTEGER NOT NULL CHECK (version >= 1),
  -- Idempotency key of the decision currently recorded on this row. A retry of
  -- the same operation is recognised here, after process restarts and from any
  -- device, without an in-process map.
  last_operation_id TEXT NOT NULL CHECK (
    length(last_operation_id) BETWEEN 1 AND 128 AND last_operation_id = trim(last_operation_id)
  ),
  PRIMARY KEY (account_id, consumer_id, news_fingerprint),
  -- Composite FK: a consumer label reused under another account is a different
  -- tenant and must never own this decision.
  FOREIGN KEY (account_id, consumer_id)
    REFERENCES guanlan_consumers(account_id, consumer_id) ON DELETE CASCADE
);

-- Status filtering for the future paginated reader (GLN-009) and for the
-- consumer-scoped candidate list: the primary key already narrows to one
-- consumer, this index narrows further by decision state.
CREATE INDEX idx_guanlan_consumer_news_states_status
  ON guanlan_consumer_news_states(account_id, consumer_id, status);
