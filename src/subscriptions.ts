import type { GuanlanPrincipal } from "./mcp/auth";

/**
 * GLN-006 · account × stable-consumer subscription/interest read contract.
 *
 * This module answers exactly one question: *which sources and interests may
 * this verified subject read?* It is the single domain entry point that later
 * consumers must reuse — GLN-009 for SQL news filtering, and the future
 * Desktop/Mobile management API instead of a parallel authorization path.
 *
 * Hard boundaries (see Issue #13):
 * - reads only; never triggers collection, never writes consumer state and
 *   never mutates `poc_sources` (subscription `interval_hours` is a preference);
 * - an empty effective set is an empty set, never a fallback to `poc_news`;
 * - identity is never taken from a tool argument, URL or ordinary DTO — see
 *   `GuanlanSubject` and `subjectFromPrincipal`.
 */

/**
 * At least as strict as the `0003` CHECK constraints: JS `trim()` strips more
 * whitespace and `.length` counts UTF-16 units, so a value the database would
 * accept but these bounds reject fails closed instead of being admitted.
 */
export const SUBJECT_ID_MAX = 128;
/** Mirrors the `0003` CHECK constraints on subscription `interval_hours`. */
export const INTERVAL_HOURS_MIN = 1;
export const INTERVAL_HOURS_MAX = 24;
/** At least as strict as the `0003` CHECK constraints on interest values. */
export const INTEREST_VALUE_MAX = 128;

declare const trustedSubject: unique symbol;

/**
 * Account × stable consumer identity that a server-side trust boundary has
 * already verified. The brand stops a plain DTO, tool argument or query value
 * from being passed where a verified subject is required without going through
 * `subjectFromPrincipal`; TypeScript cannot prove provenance, so the runtime
 * guarantee remains "only construct this from a verifier-derived principal".
 * The brand is compile-time only; `read` re-validates the shape for untyped
 * callers.
 */
export type GuanlanSubject = {
  readonly accountId: string;
  readonly consumerId: string;
  readonly [trustedSubject]: true;
};

export type SubscriptionLevel = "account" | "consumer";

/** Which configuration levels reference one effective entry. */
export type ConfigurationOrigin = "account" | "consumer" | "both";

export type InterestKind = "keyword" | "topic";

export type EffectiveSource = {
  readonly sourceId: string;
  readonly origin: ConfigurationOrigin;
  /**
   * Effective refresh preference. A consumer-specific subscription wins over
   * the account baseline; it is *not* the scheduler's authority and is never
   * written back to `poc_sources.interval_hours`.
   */
  readonly intervalHours: number;
  readonly intervalSource: SubscriptionLevel;
};

export type EffectiveInterest = {
  readonly kind: InterestKind;
  /** Stored spelling; the account's form wins when both levels match. */
  readonly value: string;
  readonly origin: ConfigurationOrigin;
};

export type EffectiveSubscription = {
  readonly accountId: string;
  readonly consumerId: string;
  /** Deduplicated, sorted by `sourceId` in code-unit order. */
  readonly sources: readonly EffectiveSource[];
  /**
   * Authorization set handed to downstream SQL filtering (GLN-009): exactly the
   * `sourceId` values of `sources`, same order. An empty array means "no
   * readable source", never "read every source".
   */
  readonly sourceIds: readonly string[];
  /** Deduplicated per kind, sorted by `kind` then folded `value`. */
  readonly interests: readonly EffectiveInterest[];
};

/**
 * Explicit denial of an otherwise well-formed request. These are decisions, not
 * errors: the caller must render them as unavailable/forbidden, never as an
 * empty-but-successful configuration.
 */
export type SubscriptionReadFailure =
  | "invalid_subject"
  | "account_not_found"
  | "consumer_not_found";

export type SubscriptionReadResult =
  | { readonly ok: true; readonly effective: EffectiveSubscription }
  | { readonly ok: false; readonly failure: SubscriptionReadFailure };

export type SubscriptionReadErrorCode = "invalid_subject" | "storage_failure";

/**
 * Thrown when a truthful answer is impossible: the principal is not a usable
 * identity, or D1 could not be read. Never downgraded to an empty result, so a
 * broken database cannot masquerade as "this subject subscribes to nothing".
 */
export class SubscriptionReadError extends Error {
  readonly code: SubscriptionReadErrorCode;

  constructor(code: SubscriptionReadErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SubscriptionReadError";
    this.code = code;
  }
}

export type SourceSubscriptionRow = {
  readonly sourceId: string;
  readonly intervalHours: number;
  readonly level: SubscriptionLevel;
};

export type InterestSubscriptionRow = {
  readonly kind: InterestKind;
  readonly value: string;
  readonly level: SubscriptionLevel;
};

const isBoundedId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= SUBJECT_ID_MAX &&
  value === value.trim();

const isIntervalHours = (value: unknown): value is number => {
  if (typeof value !== "number" || !Number.isInteger(value)) return false;
  return value >= INTERVAL_HOURS_MIN && value <= INTERVAL_HOURS_MAX;
};

const isInterestKind = (value: unknown): value is InterestKind =>
  value === "keyword" || value === "topic";

const isLevel = (value: unknown): value is SubscriptionLevel =>
  value === "account" || value === "consumer";

const isInterestValue = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= INTEREST_VALUE_MAX &&
  value === value.trim();

/**
 * Case folding that mirrors the storage layer: `0003` declares interest values
 * `COLLATE NOCASE`, which folds ASCII A-Z only. Folding more here would merge
 * values the database treats as distinct rows.
 */
const foldAsciiCase = (value: string): string =>
  value.replace(/[A-Z]/g, letter => letter.toLowerCase());

/** Locale-independent code-unit comparison, so output order is stable. */
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Builds the effective view from the two configuration levels.
 *
 * Deduplication and precedence are part of the contract and are fixed by tests:
 * - sources: one entry per `sourceId`; a source referenced by both levels keeps
 *   the consumer's `intervalHours` (more specific preference) while `origin`
 *   records that the account baseline also covers it;
 * - interests: one entry per `kind` + ASCII-folded `value`; the account's stored
 *   spelling is kept, because it is the baseline every consumer inherits;
 * - order: sources by `sourceId`, interests by `kind` then folded `value`.
 */
export function buildEffectiveConfiguration(
  accountId: string,
  consumerId: string,
  sources: readonly SourceSubscriptionRow[],
  interests: readonly InterestSubscriptionRow[],
): EffectiveSubscription {
  const bySource = new Map<string, { account?: number; consumer?: number }>();
  for (const row of sources) {
    if (!isBoundedId(row.sourceId) || !isIntervalHours(row.intervalHours) || !isLevel(row.level)) {
      throw new SubscriptionReadError(
        "storage_failure",
        "a subscription row is outside the stored contract",
      );
    }
    const levels = bySource.get(row.sourceId) ?? {};
    if (row.level === "account") levels.account = row.intervalHours;
    else levels.consumer = row.intervalHours;
    bySource.set(row.sourceId, levels);
  }

  const effectiveSources: EffectiveSource[] = [...bySource.entries()]
    .sort(([left], [right]) => compare(left, right))
    .map(([sourceId, levels]) => {
      const intervalHours = levels.consumer ?? levels.account;
      if (intervalHours === undefined) {
        throw new SubscriptionReadError(
          "storage_failure",
          "a subscription row lost its configuration level",
        );
      }
      return {
        sourceId,
        origin: levels.consumer !== undefined && levels.account !== undefined
          ? "both"
          : levels.consumer !== undefined
            ? "consumer"
            : "account",
        intervalHours,
        intervalSource: levels.consumer !== undefined ? "consumer" : "account",
      };
    });

  const byInterest = new Map<string, EffectiveInterest>();
  for (const row of interests) {
    if (!isInterestKind(row.kind) || !isInterestValue(row.value) || !isLevel(row.level)) {
      throw new SubscriptionReadError(
        "storage_failure",
        "an interest row is outside the stored contract",
      );
    }
    const key = `${row.kind}\u0000${foldAsciiCase(row.value)}`;
    const existing = byInterest.get(key);
    if (!existing) {
      byInterest.set(key, { kind: row.kind, value: row.value, origin: row.level });
      continue;
    }
    if (existing.origin === "both") continue;
    if (existing.origin === row.level) {
      // Same level twice (unreachable through the NOCASE primary key, but this
      // function is exported): keep the smaller spelling so output does not
      // depend on row order.
      if (compare(row.value, existing.value) < 0) {
        byInterest.set(key, { ...existing, value: row.value });
      }
      continue;
    }
    byInterest.set(key, {
      kind: row.kind,
      // Keep the account baseline spelling whichever row arrived first.
      value: existing.origin === "account" ? existing.value : row.value,
      origin: "both",
    });
  }

  const effectiveInterests = [...byInterest.values()]
    .sort((left, right) =>
      compare(left.kind, right.kind) || compare(foldAsciiCase(left.value), foldAsciiCase(right.value)))
    .map(interest => ({
      kind: interest.kind,
      value: interest.value,
      origin: interest.origin,
    }));

  return {
    accountId,
    consumerId,
    sources: effectiveSources,
    sourceIds: effectiveSources.map(source => source.sourceId),
    interests: effectiveInterests,
  };
}

/**
 * The only construction site for a trusted subject. Pass the principal returned
 * by `principalFromAuthInfo(...)`, i.e. one derived from an already-verified
 * credential. This module cannot prove provenance — a hand-built object of the
 * same shape also compiles — so the trust boundary stays at the verifier, and
 * the brand only prevents a subject from being wired up without this call.
 */
export function subjectFromPrincipal(principal: GuanlanPrincipal): GuanlanSubject {
  if (!isBoundedId(principal.accountId) || !isBoundedId(principal.consumerId)) {
    throw new SubscriptionReadError(
      "invalid_subject",
      "the verified principal does not carry a usable account/consumer identity",
    );
  }
  return {
    accountId: principal.accountId,
    consumerId: principal.consumerId,
  } as GuanlanSubject;
}

/** Read-only domain port shared by MCP and the future management API. */
export interface GuanlanSubscriptionReader {
  read(subject: GuanlanSubject): Promise<SubscriptionReadResult>;
}

type ExistenceRow = { accounts: number; consumers: number };
type SourceRow = { source_id: string; interval_hours: number; level: string };
type InterestRow = { kind: string; value: string; level: string };

const STORAGE_FAILURE = "subscription_read_failed";

/**
 * D1 implementation. Every statement is a `SELECT`: this port can never ingest,
 * write consumer state or change scheduling. The three reads run as one D1
 * batch so a concurrent configuration change cannot produce a torn view.
 */
export function createD1SubscriptionReader(db: D1Database): GuanlanSubscriptionReader {
  return {
    async read(subject: GuanlanSubject): Promise<SubscriptionReadResult> {
      // The brand is erased at runtime, so a JavaScript caller could bypass it.
      // Reject the shape before touching the database.
      if (!isBoundedId(subject.accountId) || !isBoundedId(subject.consumerId)) {
        return { ok: false, failure: "invalid_subject" };
      }

      let results: D1Result<unknown>[];
      try {
        results = await db.batch([
          db.prepare(`
            SELECT
              (SELECT COUNT(*) FROM guanlan_accounts WHERE account_id = ?) AS accounts,
              (SELECT COUNT(*) FROM guanlan_consumers
                WHERE account_id = ? AND consumer_id = ?) AS consumers
          `).bind(subject.accountId, subject.accountId, subject.consumerId),
          db.prepare(`
            SELECT source_id, interval_hours, 'account' AS level
              FROM guanlan_account_subscriptions WHERE account_id = ?
            UNION ALL
            SELECT source_id, interval_hours, 'consumer' AS level
              FROM guanlan_consumer_subscriptions
              WHERE account_id = ? AND consumer_id = ?
          `).bind(subject.accountId, subject.accountId, subject.consumerId),
          db.prepare(`
            SELECT kind, value, 'account' AS level
              FROM guanlan_account_interests WHERE account_id = ?
            UNION ALL
            SELECT kind, value, 'consumer' AS level
              FROM guanlan_consumer_interests
              WHERE account_id = ? AND consumer_id = ?
          `).bind(subject.accountId, subject.accountId, subject.consumerId),
        ]);
      } catch (error) {
        throw new SubscriptionReadError("storage_failure", STORAGE_FAILURE, { cause: error });
      }

      const [existence, sources, interests] = results;
      if (!existence?.success || !sources?.success || !interests?.success) {
        throw new SubscriptionReadError("storage_failure", STORAGE_FAILURE);
      }

      const ownerRows = existence.results;
      const sourceRows = sources.results;
      const interestRows = interests.results;
      // A lost or reshaped result set must never read as "this subject has no
      // configuration": require the exact shapes the three queries promise
      // before interpreting anything.
      if (
        !Array.isArray(ownerRows) || ownerRows.length !== 1 ||
        !Array.isArray(sourceRows) || !Array.isArray(interestRows)
      ) {
        throw new SubscriptionReadError("storage_failure", STORAGE_FAILURE);
      }
      const owner = ownerRows[0] as Partial<ExistenceRow>;
      if (typeof owner.accounts !== "number" || typeof owner.consumers !== "number") {
        throw new SubscriptionReadError("storage_failure", STORAGE_FAILURE);
      }
      if (owner.accounts === 0) return { ok: false, failure: "account_not_found" };
      if (owner.consumers === 0) return { ok: false, failure: "consumer_not_found" };

      const effective = buildEffectiveConfiguration(
        subject.accountId,
        subject.consumerId,
        (sourceRows as SourceRow[]).map(row => ({
          sourceId: row.source_id,
          intervalHours: row.interval_hours,
          level: row.level as SubscriptionLevel,
        })),
        (interestRows as InterestRow[]).map(row => ({
          kind: row.kind as InterestKind,
          value: row.value,
          level: row.level as SubscriptionLevel,
        })),
      );

      return { ok: true, effective };
    },
  };
}
