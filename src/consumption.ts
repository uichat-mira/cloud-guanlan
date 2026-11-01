import { canonicalNewsUrl } from "./parser";
import {
  SUBJECT_ID_MAX,
  type GuanlanSubject,
  type GuanlanSubscriptionReader,
} from "./subscriptions";

/**
 * GLN-007 · account × stable consumer × canonical news URL decision ledger.
 *
 * This module owns exactly one domain question: *what does one verified consumer
 * currently think about one article, and how may that decision change?* It is
 * the single write/read entry point that GLN-009 and the future management API
 * must reuse instead of a parallel status table.
 *
 * Hard boundaries (see Issue #14):
 * - the subject comes only from a verifier-derived `GuanlanSubject` (GLN-006);
 *   no tool argument or ordinary DTO may name another account/consumer;
 * - a write is authorized through GLN-006's effective source set, so an
 *   unsubscribed or unknown source/news is an explicit denial, never `unread`;
 * - `unread` is the absence of a row: reading never writes a decision;
 * - ordering authority is a per-row `version` guarded by compare-and-set, never
 *   a client clock or "last write wins";
 * - replay is recognised from a persisted operation id, so it survives process
 *   restarts, new requests and other devices without an in-process map;
 * - identity is a SHA-256 fingerprint of the canonical article URL. The ledger
 *   stores no title, summary or body and has no foreign key to `poc_news`, so a
 *   news-index purge cannot delete or shrink a consumer's decision memory.
 */

export const CONSUMPTION_STATUSES = ["pending", "adopted", "ignored"] as const;

/** Explicit states only. `unread` is the absence of a record, never stored. */
export type ConsumptionStatus = (typeof CONSUMPTION_STATUSES)[number];

/** Effective status returned to callers: stored decisions plus implied unread. */
export type EffectiveConsumptionStatus = ConsumptionStatus | "unread";

/** Bounded batch size for one state read, mirroring the MCP news page limit. */
export const CONSUMPTION_BATCH_MAX = 50;
/** Mirrors the `0004` CHECK constraint on `reason`. */
export const CONSUMPTION_REASON_MAX = 500;
/** Mirrors the `0004` CHECK constraint on `outcome_url`. */
export const CONSUMPTION_OUTCOME_URL_MAX = 2_048;
/** Mirrors the `0004` CHECK constraint on `last_operation_id`. */
export const CONSUMPTION_OPERATION_ID_MAX = 128;
/** SHA-256 hex length stored in `news_fingerprint`. */
export const NEWS_FINGERPRINT_LENGTH = 64;

export type ConsumptionStateView = {
  /** Canonical article URL the caller asked about (fragment removed). */
  readonly url: string;
  /** Stable decision identity: SHA-256 of `url`. */
  readonly fingerprint: string;
  /** Source the decision was authorized under; `null` for an implied unread. */
  readonly sourceId: string | null;
  readonly status: EffectiveConsumptionStatus;
  /** `0` for `unread`; monotonically increasing per stored decision. */
  readonly version: number;
  readonly reason: string | null;
  readonly outcomeUrl: string | null;
  /** Server-assigned decision time; `null` for `unread`. Never ordering input. */
  readonly decidedAt: string | null;
};

export type ConsumptionReadRequest = {
  /** 1..`CONSUMPTION_BATCH_MAX` article URLs; duplicates collapse. */
  readonly urls: readonly string[];
};

export type ConsumptionReadFailure =
  | "invalid_subject"
  | "invalid_request"
  | "account_not_found"
  | "consumer_not_found"
  | "news_not_found"
  | "source_not_authorized";

export type ConsumptionReadResult =
  | { readonly ok: true; readonly states: readonly ConsumptionStateView[] }
  | { readonly ok: false; readonly failure: ConsumptionReadFailure };

export type ConsumptionWriteRequest = {
  /** Article URL; it is canonicalized with the collection rule before use. */
  readonly url: string;
  readonly status: ConsumptionStatus;
  /**
   * Compare-and-set precondition: the version the caller last observed for this
   * decision. `0` means "I expect no decision yet" (`unread`). A stale value is
   * rejected instead of silently overwriting a newer decision.
   */
  readonly expectedVersion: number;
  /**
   * Idempotency key of this single decision. Retrying the same decision with the
   * same id is a replay: no new version, no new timestamp, no second row. A new
   * decision (even to the same status) needs a new id.
   */
  readonly operationId: string;
  readonly reason?: string | null;
  /** Bounded http(s) link to the result this decision produced. */
  readonly outcomeUrl?: string | null;
};

export type ConsumptionWriteFailure =
  | "invalid_subject"
  | "invalid_request"
  | "account_not_found"
  | "consumer_not_found"
  | "news_not_found"
  | "source_not_authorized"
  | "version_conflict"
  | "operation_conflict";

export type ConsumptionWriteResult =
  | {
    readonly ok: true;
    /** `updated` applied the decision; `replayed` recognised an exact retry. */
    readonly result: "updated" | "replayed";
    readonly state: ConsumptionStateView;
  }
  | {
    readonly ok: false;
    readonly failure: ConsumptionWriteFailure;
    /** Present for `version_conflict` / `operation_conflict`: current truth. */
    readonly current?: ConsumptionStateView;
  };

export type ConsumptionLedgerErrorCode = "invalid_subject" | "storage_failure";

/**
 * Thrown when a truthful answer is impossible: the subject is not a usable
 * identity, or D1 could not be read/written. Never downgraded to `unread` or to
 * an empty result, so a broken database cannot masquerade as "nothing decided".
 */
export class ConsumptionLedgerError extends Error {
  readonly code: ConsumptionLedgerErrorCode;

  constructor(code: ConsumptionLedgerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConsumptionLedgerError";
    this.code = code;
  }
}

export type ConsumptionLedgerDependencies = {
  readonly db: D1Database;
  /** GLN-006 reader: the only source of the authorized source set. */
  readonly subscriptions: GuanlanSubscriptionReader;
  /** Injected clock for tests; timestamps never influence ordering. */
  readonly now?: () => Date;
};

/** Domain port shared by GLN-009, MCP wiring and the future management API. */
export interface GuanlanConsumptionLedger {
  read(subject: GuanlanSubject, request: ConsumptionReadRequest): Promise<ConsumptionReadResult>;
  write(subject: GuanlanSubject, request: ConsumptionWriteRequest): Promise<ConsumptionWriteResult>;
}

type LedgerRow = {
  readonly news_fingerprint: string;
  readonly source_id: string;
  readonly status: ConsumptionStatus;
  readonly reason: string | null;
  readonly outcome_url: string | null;
  readonly decided_at: string;
  readonly version: number;
  readonly last_operation_id: string;
};

const ROW_OUTSIDE_CONTRACT = "consumption_row_outside_contract";
const READ_FAILED = "consumption_read_failed";
const WRITE_FAILED = "consumption_write_failed";
const UNCLASSIFIED = "consumption_write_not_classified";

const encoder = new TextEncoder();

const isBoundedId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= SUBJECT_ID_MAX &&
  value === value.trim();

const isConsumptionStatus = (value: unknown): value is ConsumptionStatus =>
  value === "pending" || value === "adopted" || value === "ignored";

const isExpectedVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isOperationId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= CONSUMPTION_OPERATION_ID_MAX &&
  value === value.trim();

const isReason = (value: string): boolean =>
  value.length >= 1 && value.length <= CONSUMPTION_REASON_MAX && value === value.trim();

const isOutcomeUrl = (value: string): boolean => {
  if (value.length < 1 || value.length > CONSUMPTION_OUTCOME_URL_MAX || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    // Only a fetchable http(s) result link; a `javascript:`/`data:` value is
    // stored data, not a link, and is refused here.
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
};

const isFingerprint = (value: unknown): value is string =>
  typeof value === "string" && value.length === NEWS_FINGERPRINT_LENGTH && /^[0-9a-f]+$/.test(value);

/** `undefined` = invalid, `null` = absent, string = stored value. */
const normalizeReason = (value: unknown): string | null | undefined => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !isReason(value)) return undefined;
  return value;
};

/** `undefined` = invalid, `null` = absent, string = stored value. */
const normalizeOutcomeUrl = (value: unknown): string | null | undefined => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !isOutcomeUrl(value)) return undefined;
  return value;
};

/**
 * Deterministic identity of a canonical article URL. The input must already be
 * the canonical form produced by `canonicalNewsUrl`; the ledger never normalizes
 * twice, so two URLs that the collector treats as distinct can never collapse.
 */
export async function fingerprintForCanonicalUrl(canonicalUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalUrl));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Convenience for callers/tests: canonicalize then fingerprint, or `null`. */
export async function fingerprintNewsUrl(raw: string): Promise<string | null> {
  const canonical = canonicalNewsUrl(raw);
  return canonical === null ? null : fingerprintForCanonicalUrl(canonical);
}

const parseLedgerRow = (raw: unknown): LedgerRow => {
  if (!raw || typeof raw !== "object") {
    throw new ConsumptionLedgerError("storage_failure", ROW_OUTSIDE_CONTRACT);
  }
  const row = raw as Record<string, unknown>;
  if (!isFingerprint(row.news_fingerprint)) throw new ConsumptionLedgerError("storage_failure", ROW_OUTSIDE_CONTRACT);
  if (typeof row.source_id !== "string" || row.source_id.length < 1) {
    throw new ConsumptionLedgerError("storage_failure", ROW_OUTSIDE_CONTRACT);
  }
  if (!isConsumptionStatus(row.status)) throw new ConsumptionLedgerError("storage_failure", ROW_OUTSIDE_CONTRACT);
  if (row.reason !== null && (typeof row.reason !== "string" || !isReason(row.reason))) {
    throw new ConsumptionLedgerError("storage_failure", ROW_OUTSIDE_CONTRACT);
  }
  if (row.outcome_url !== null && (typeof row.outcome_url !== "string" || !isOutcomeUrl(row.outcome_url))) {
    throw new ConsumptionLedgerError("storage_failure", ROW_OUTSIDE_CONTRACT);
  }
  if (typeof row.decided_at !== "string" || row.decided_at.length < 1 || row.decided_at.length > 64) {
    throw new ConsumptionLedgerError("storage_failure", ROW_OUTSIDE_CONTRACT);
  }
  if (typeof row.version !== "number" || !Number.isInteger(row.version) || row.version < 1) {
    throw new ConsumptionLedgerError("storage_failure", ROW_OUTSIDE_CONTRACT);
  }
  if (!isOperationId(row.last_operation_id)) {
    throw new ConsumptionLedgerError("storage_failure", ROW_OUTSIDE_CONTRACT);
  }
  return {
    news_fingerprint: row.news_fingerprint,
    source_id: row.source_id,
    status: row.status,
    reason: row.reason as string | null,
    outcome_url: row.outcome_url as string | null,
    decided_at: row.decided_at,
    version: row.version,
    last_operation_id: row.last_operation_id,
  };
};

const viewOf = (url: string, row: LedgerRow): ConsumptionStateView => ({
  url,
  fingerprint: row.news_fingerprint,
  sourceId: row.source_id,
  status: row.status,
  version: row.version,
  reason: row.reason,
  outcomeUrl: row.outcome_url,
  decidedAt: row.decided_at,
});

const unreadView = (url: string, fingerprint: string, sourceId: string | null): ConsumptionStateView => ({
  url,
  fingerprint,
  sourceId,
  status: "unread",
  version: 0,
  reason: null,
  outcomeUrl: null,
  decidedAt: null,
});

const mapAuthorizationFailure = (
  failure: "invalid_subject" | "account_not_found" | "consumer_not_found",
): ConsumptionReadFailure => failure;

type ValidatedWrite = {
  readonly canonicalUrl: string;
  readonly status: ConsumptionStatus;
  readonly expectedVersion: number;
  readonly operationId: string;
  readonly reason: string | null;
  readonly outcomeUrl: string | null;
};

const validateWriteRequest = (request: ConsumptionWriteRequest): ValidatedWrite | null => {
  if (!request || typeof request !== "object") return null;
  const canonicalUrl = canonicalNewsUrl(request.url);
  if (canonicalUrl === null) return null;
  if (!isConsumptionStatus(request.status)) return null;
  if (!isExpectedVersion(request.expectedVersion)) return null;
  if (!isOperationId(request.operationId)) return null;
  const reason = normalizeReason(request.reason);
  if (reason === undefined) return null;
  const outcomeUrl = normalizeOutcomeUrl(request.outcomeUrl);
  if (outcomeUrl === undefined) return null;
  return {
    canonicalUrl,
    status: request.status,
    expectedVersion: request.expectedVersion,
    operationId: request.operationId,
    reason,
    outcomeUrl,
  };
};

/** Canonical, de-duplicated URLs in first-occurrence order, or `null`. */
const validateReadRequest = (request: ConsumptionReadRequest): string[] | null => {
  if (!request || typeof request !== "object") return null;
  const urls = request.urls;
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > CONSUMPTION_BATCH_MAX) return null;
  const seen = new Set<string>();
  const canonical: string[] = [];
  for (const raw of urls) {
    if (typeof raw !== "string") return null;
    const url = canonicalNewsUrl(raw);
    if (url === null) return null;
    if (seen.has(url)) continue;
    seen.add(url);
    canonical.push(url);
  }
  return canonical;
};

const LEDGER_COLUMNS =
  "news_fingerprint, source_id, status, reason, outcome_url, decided_at, version, last_operation_id";

/**
 * D1 implementation. Every read is a pure `SELECT` batch; every write is one
 * D1 batch (a transaction) containing the conditional upsert, the current-row
 * read and the news-source read, so classification never observes a torn state.
 */
export function createD1ConsumptionLedger(
  dependencies: ConsumptionLedgerDependencies,
): GuanlanConsumptionLedger {
  const { db, subscriptions } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  return {
    async read(subject: GuanlanSubject, request: ConsumptionReadRequest): Promise<ConsumptionReadResult> {
      // The brand is erased at runtime: re-validate before touching the database.
      if (!isBoundedId(subject?.accountId) || !isBoundedId(subject?.consumerId)) {
        return { ok: false, failure: "invalid_subject" };
      }
      const urls = validateReadRequest(request);
      if (urls === null) return { ok: false, failure: "invalid_request" };

      // GLN-006 is the single authorization source: it also proves that the
      // account and consumer exist. Never fall back to reading every source.
      const authorization = await subscriptions.read(subject);
      if (!authorization.ok) {
        return { ok: false, failure: mapAuthorizationFailure(authorization.failure) };
      }
      const allowed = new Set(authorization.effective.sourceIds);

      const fingerprints = await Promise.all(urls.map(fingerprintForCanonicalUrl));
      const placeholders = fingerprints.map(() => "?").join(",");
      let results: D1Result<unknown>[];
      try {
        results = await db.batch([
          db.prepare(`
            SELECT ${LEDGER_COLUMNS}
            FROM guanlan_consumer_news_states
            WHERE account_id = ? AND consumer_id = ?
              AND news_fingerprint IN (${placeholders})
          `).bind(subject.accountId, subject.consumerId, ...fingerprints),
          db.prepare(`SELECT url, source_id FROM poc_news WHERE url IN (${placeholders})`)
            .bind(...urls),
        ]);
      } catch (error) {
        throw new ConsumptionLedgerError("storage_failure", READ_FAILED, { cause: error });
      }

      const [ledgerResult, newsResult] = results;
      if (!ledgerResult?.success || !newsResult?.success) {
        throw new ConsumptionLedgerError("storage_failure", READ_FAILED);
      }
      const ledgerRows = ledgerResult.results;
      const newsRows = newsResult.results;
      if (!Array.isArray(ledgerRows) || !Array.isArray(newsRows)) {
        throw new ConsumptionLedgerError("storage_failure", READ_FAILED);
      }

      const byFingerprint = new Map<string, LedgerRow>();
      for (const raw of ledgerRows) {
        const row = parseLedgerRow(raw);
        byFingerprint.set(row.news_fingerprint, row);
      }
      const newsSourceByUrl = new Map<string, string>();
      for (const raw of newsRows) {
        const row = raw as { url?: unknown; source_id?: unknown };
        if (typeof row.url !== "string" || typeof row.source_id !== "string" || row.source_id.length < 1) {
          throw new ConsumptionLedgerError("storage_failure", READ_FAILED);
        }
        newsSourceByUrl.set(row.url, row.source_id);
      }

      const states: ConsumptionStateView[] = [];
      for (const [index, url] of urls.entries()) {
        const fingerprint = fingerprints[index];
        const row = byFingerprint.get(fingerprint) ?? null;
        const newsSource = newsSourceByUrl.get(url) ?? null;
        // Neither a current index row nor a stored decision: this URL is not a
        // news identity we may answer for. It is never silently `unread`.
        if (row === null && newsSource === null) {
          return { ok: false, failure: "news_not_found" };
        }
        // Authorization is the union of the source the decision was made under
        // and the source the article is currently collected from. The union is
        // required so a purged-then-recollected article stays readable, and it
        // never lets a source outside the current effective set through.
        const known = [row?.source_id, newsSource].filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        );
        if (!known.some(sourceId => allowed.has(sourceId))) {
          return { ok: false, failure: "source_not_authorized" };
        }
        states.push(row === null ? unreadView(url, fingerprint, newsSource) : viewOf(url, row));
      }
      return { ok: true, states };
    },

    async write(subject: GuanlanSubject, request: ConsumptionWriteRequest): Promise<ConsumptionWriteResult> {
      if (!isBoundedId(subject?.accountId) || !isBoundedId(subject?.consumerId)) {
        return { ok: false, failure: "invalid_subject" };
      }
      const valid = validateWriteRequest(request);
      if (valid === null) return { ok: false, failure: "invalid_request" };

      const authorization = await subscriptions.read(subject);
      if (!authorization.ok) {
        return { ok: false, failure: mapAuthorizationFailure(authorization.failure) };
      }
      const allowed = new Set(authorization.effective.sourceIds);
      const fingerprint = await fingerprintForCanonicalUrl(valid.canonicalUrl);
      const decidedAt = now().toISOString();
      if (decidedAt.length < 1 || decidedAt.length > 64) {
        throw new ConsumptionLedgerError("storage_failure", WRITE_FAILED);
      }

      // One statement is the whole decision: it can only insert when the news
      // row exists AND its source is inside the GLN-006 effective set, and it
      // can only update when the caller's expected version still matches and
      // the same operation was not already applied. There is no read-then-write
      // gap inside the batch.
      const upsert = db.prepare(`
        INSERT INTO guanlan_consumer_news_states (
          account_id, consumer_id, news_fingerprint, source_id,
          status, reason, outcome_url, decided_at, version, last_operation_id
        )
        SELECT ?, ?, ?, news.source_id, ?, ?, ?, ?, 1, ?
        FROM poc_news AS news
        WHERE news.url = ?
          AND news.source_id IN (SELECT value FROM json_each(?))
          -- A missing decision may only be inserted when the caller expects
          -- version 0; existing rows remain eligible for the CAS update below.
          AND (? = 0 OR EXISTS (
            SELECT 1 FROM guanlan_consumer_news_states AS existing
            WHERE existing.account_id = ?
              AND existing.consumer_id = ?
              AND existing.news_fingerprint = ?
          ))
        ON CONFLICT (account_id, consumer_id, news_fingerprint) DO UPDATE SET
          source_id = excluded.source_id,
          status = excluded.status,
          reason = excluded.reason,
          outcome_url = excluded.outcome_url,
          decided_at = excluded.decided_at,
          version = guanlan_consumer_news_states.version + 1,
          last_operation_id = excluded.last_operation_id
        WHERE guanlan_consumer_news_states.version = ?
          AND guanlan_consumer_news_states.last_operation_id <> ?
      `).bind(
        subject.accountId,
        subject.consumerId,
        fingerprint,
        valid.status,
        valid.reason,
        valid.outcomeUrl,
        decidedAt,
        valid.operationId,
        valid.canonicalUrl,
        JSON.stringify([...allowed]),
        valid.expectedVersion,
        subject.accountId,
        subject.consumerId,
        fingerprint,
        valid.expectedVersion,
        valid.operationId,
      );

      let results: D1Result<unknown>[];
      try {
        results = await db.batch([
          upsert,
          db.prepare(`
            SELECT ${LEDGER_COLUMNS}
            FROM guanlan_consumer_news_states
            WHERE account_id = ? AND consumer_id = ? AND news_fingerprint = ?
          `).bind(subject.accountId, subject.consumerId, fingerprint),
          db.prepare("SELECT source_id FROM poc_news WHERE url = ?").bind(valid.canonicalUrl),
        ]);
      } catch (error) {
        throw new ConsumptionLedgerError("storage_failure", WRITE_FAILED, { cause: error });
      }

      const [writeResult, stateResult, newsResult] = results;
      if (!writeResult?.success || !stateResult?.success || !newsResult?.success) {
        throw new ConsumptionLedgerError("storage_failure", WRITE_FAILED);
      }
      const stateRows = stateResult.results;
      const newsRows = newsResult.results;
      if (!Array.isArray(stateRows) || !Array.isArray(newsRows) || stateRows.length > 1) {
        throw new ConsumptionLedgerError("storage_failure", WRITE_FAILED);
      }
      const current = stateRows.length === 1 ? parseLedgerRow(stateRows[0]) : null;
      const changed = writeResult.meta?.changes ?? 0;

      if (changed > 1) throw new ConsumptionLedgerError("storage_failure", WRITE_FAILED);
      if (changed === 1) {
        // The upsert wrote a row, so the follow-up SELECT in the same batch must
        // show it; anything else is a storage anomaly, not a business answer.
        if (current === null) throw new ConsumptionLedgerError("storage_failure", WRITE_FAILED);
        return { ok: true, result: "updated", state: viewOf(valid.canonicalUrl, current) };
      }

      // Nothing was written: classify why, using the news row read in the same
      // transaction. Authorization is decided before replay/conflict so a write
      // against a no-longer-authorized source never reports success.
      const newsRow = newsRows[0] as { source_id?: unknown } | undefined;
      if (!newsRow || typeof newsRow.source_id !== "string" || newsRow.source_id.length < 1) {
        return { ok: false, failure: "news_not_found" };
      }
      if (!allowed.has(newsRow.source_id)) {
        return { ok: false, failure: "source_not_authorized" };
      }
      if (current === null) {
        // An expected previous version does not exist. Return a regular
        // optimistic-concurrency conflict without creating an implicit row.
        if (valid.expectedVersion !== 0) {
          return {
            ok: false,
            failure: "version_conflict",
            current: unreadView(valid.canonicalUrl, fingerprint, newsRow.source_id),
          };
        }
        throw new ConsumptionLedgerError("storage_failure", UNCLASSIFIED);
      }

      const state = viewOf(valid.canonicalUrl, current);
      if (current.last_operation_id === valid.operationId) {
        const sameDecision =
          current.status === valid.status &&
          current.reason === valid.reason &&
          current.outcome_url === valid.outcomeUrl;
        // Replay check precedes the version check: a client that lost the first
        // response retries with its original `expectedVersion` and still gets a
        // truthful `replayed` instead of a spurious conflict.
        return sameDecision
          ? { ok: true, result: "replayed", state }
          : { ok: false, failure: "operation_conflict", current: state };
      }
      if (current.version !== valid.expectedVersion) {
        return { ok: false, failure: "version_conflict", current: state };
      }
      throw new ConsumptionLedgerError("storage_failure", UNCLASSIFIED);
    },
  };
}
