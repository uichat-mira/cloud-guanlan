import type { GuanlanPrincipal } from "./mcp/auth";
import { evaluateSourceUrl } from "./source-safety";
import {
  INTERVAL_HOURS_MAX,
  INTERVAL_HOURS_MIN,
  createD1SubscriptionReader,
  subjectFromPrincipal,
  type EffectiveSubscription,
  type GuanlanSubject,
  type SubscriptionLevel,
  type SubscriptionReadResult,
} from "./subscriptions";

/**
 * GLN-011 · minimal account/consumer subscription mutation domain port.
 *
 * This module is the only supported write path for the two GLN-005 subscription
 * tables. It answers one question: *may this trusted manager add, re-price or
 * remove one already-approved source for its own account/consumer?*
 *
 * Hard boundaries (see Issue #23):
 * - it never writes `poc_sources`, `poc_news`, leases, consumer state or
 *   interests; `intervalHours` is a subscription preference, never scheduler
 *   configuration;
 * - it never registers a source. A source id is accepted only when the stored
 *   `poc_sources.url` still passes the GLN-008 exact-allowlist policy, so a
 *   historical `poc_sources` row cannot become a subscription backdoor;
 * - it does not merge account and consumer configuration itself. The effective
 *   view returned after every successful mutation comes from the existing
 *   GLN-006 `createD1SubscriptionReader`, so there is exactly one inheritance
 *   algorithm in the codebase;
 * - identity is never taken from the mutation input. Account and consumer ids
 *   are derived from a verified principal inside a management grant; the
 *   mutation DTO has no account/consumer field at all.
 *
 * There is deliberately **no** production management policy in this card:
 * Cloud Auth has not frozen a Guanlan management-authority contract yet. A
 * future caller must implement `GuanlanManagementPolicy` against the verified
 * credential and call `managementGrantFromPrincipal`; the test suite injects a
 * fixture policy that stands in for that server-side trust boundary.
 */

declare const trustedManagementGrant: unique symbol;

/**
 * Account-level management may change the shared account baseline. Consumer
 * management may change only the acting consumer's own increment; it can never
 * touch the shared baseline. The two authorities are intentionally not
 * hierarchical in this card: an account manager is not silently allowed to
 * rewrite another consumer's private configuration, and a consumer manager is
 * not allowed to rewrite the account baseline.
 */
export type GuanlanManagementAuthority = "account" | "consumer";

/**
 * A management capability produced by a trusted server-side authorization
 * boundary. The brand stops a plain principal, subject, DTO or tool argument
 * from being wired up as management authority by accident; TypeScript cannot
 * prove provenance, so the real trust boundary is the policy that calls
 * `managementGrantFromPrincipal`. The brand is erased at runtime, and the
 * mutation port re-validates the principal shape before touching D1.
 */
export type GuanlanManagementGrant = {
  readonly authority: GuanlanManagementAuthority;
  /** Verified credential principal; carries the account/consumer identity. */
  readonly principal: GuanlanPrincipal;
  readonly [trustedManagementGrant]: true;
};

export type ManagementAuthorizationFailure = "invalid_principal" | "not_authorized";

export type ManagementAuthorization =
  | { readonly ok: true; readonly grant: GuanlanManagementGrant }
  | { readonly ok: false; readonly failure: ManagementAuthorizationFailure };

/**
 * Trusted server-side authorization boundary for configuration writes.
 *
 * GLN-011 ships no implementation because Cloud Auth owns management authority
 * and has no formal Guanlan contract yet. An implementation must derive the
 * authority from a verified credential (not from user-reported role, account or
 * consumer values) and then call `managementGrantFromPrincipal`. Read-only
 * news scopes never imply either authority.
 */
export interface GuanlanManagementPolicy {
  authorize(principal: GuanlanPrincipal): ManagementAuthorization;
}

/**
 * The only construction site for a management grant. Call it from the trusted
 * policy boundary with an authority the policy has already verified. The
 * principal is re-validated through GLN-006's `subjectFromPrincipal`, so an
 * unusable account/consumer identity cannot become a grant.
 */
export function managementGrantFromPrincipal(
  principal: GuanlanPrincipal,
  authority: GuanlanManagementAuthority,
): ManagementAuthorization {
  if (authority !== "account" && authority !== "consumer") {
    return { ok: false, failure: "not_authorized" };
  }
  try {
    // Reuses the GLN-006 identity contract instead of maintaining a second one.
    subjectFromPrincipal(principal);
  } catch {
    return { ok: false, failure: "invalid_principal" };
  }
  return {
    ok: true,
    grant: {
      authority,
      principal: { ...principal, scopes: [...principal.scopes] },
    } as GuanlanManagementGrant,
  };
}

/**
 * Explicit denials of a well-formed request. These are decisions, not storage
 * errors. `account_not_found`/`consumer_not_found` describe only the grant's
 * own subject (the authenticated manager), never another tenant; a consumer
 * manager cannot name another consumer because the mutation input has no
 * consumer id.
 */
export type SubscriptionMutationFailure =
  | "invalid_input"
  | "forbidden"
  | "account_not_found"
  | "consumer_not_found"
  | "source_not_found"
  | "source_not_approved";

export type SubscriptionMutationSuccess = {
  readonly ok: true;
  /** True only when this call inserted, changed or deleted a stored row. */
  readonly changed: boolean;
  readonly level: SubscriptionLevel;
  readonly sourceId: string;
  /** Stored preference after the call; `null` after a remove. */
  readonly intervalHours: number | null;
  /** GLN-006 effective view of the acting consumer after the mutation. */
  readonly effective: EffectiveSubscription;
};

export type SubscriptionMutationResult =
  | SubscriptionMutationSuccess
  | { readonly ok: false; readonly failure: SubscriptionMutationFailure };

export type SubscriptionMutationErrorCode = "storage_failure";

/**
 * Thrown when a truthful answer is impossible: D1 failed, a batch result did
 * not match what the statements promise, or the post-write GLN-006 read could
 * not resolve the subject. Never downgraded to an empty or successful result.
 * The writes are idempotent, so a caller may retry the same mutation.
 */
export class SubscriptionMutationError extends Error {
  readonly code: SubscriptionMutationErrorCode;

  constructor(code: SubscriptionMutationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SubscriptionMutationError";
    this.code = code;
  }
}

/** Domain write port. Reused by the future management API; not wired to MCP. */
export interface GuanlanSubscriptionMutator {
  mutate(grant: GuanlanManagementGrant, input: unknown): Promise<SubscriptionMutationResult>;
}

type ParsedMutation =
  | { readonly level: "account"; readonly op: "upsert"; readonly sourceId: string; readonly intervalHours: number }
  | { readonly level: "account"; readonly op: "remove"; readonly sourceId: string }
  | { readonly level: "consumer"; readonly op: "upsert"; readonly sourceId: string; readonly intervalHours: number }
  | { readonly level: "consumer"; readonly op: "remove"; readonly sourceId: string };

/**
 * `poc_sources.id` has no length or trim CHECK (see GLN-006), so the port
 * mirrors that storage contract: any non-empty stored id is a candidate. The
 * source row must still exist and pass the allowlist before it is usable.
 */
const isStoredSourceId = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1;

const parseMutation = (input: unknown): ParsedMutation | null => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const candidate = input as Record<string, unknown>;
  const level = candidate.level;
  const op = candidate.op;
  if (level !== "account" && level !== "consumer") return null;
  if (op !== "upsert" && op !== "remove") return null;
  if (!isStoredSourceId(candidate.sourceId)) return null;

  if (op === "remove") {
    return level === "account"
      ? { level: "account", op, sourceId: candidate.sourceId }
      : { level: "consumer", op, sourceId: candidate.sourceId };
  }

  const intervalHours = candidate.intervalHours;
  if (
    typeof intervalHours !== "number" ||
    !Number.isInteger(intervalHours) ||
    intervalHours < INTERVAL_HOURS_MIN ||
    intervalHours > INTERVAL_HOURS_MAX
  ) {
    return null;
  }
  return level === "account"
    ? { level: "account", op, sourceId: candidate.sourceId, intervalHours }
    : { level: "consumer", op, sourceId: candidate.sourceId, intervalHours };
};

/**
 * The brand is erased at runtime, so a JavaScript caller could hand over a
 * forged shape. Reject anything that is not a usable grant before touching D1;
 * `subjectFromPrincipal` below remains the authority on the identity itself.
 */
const isGrant = (value: unknown): value is GuanlanManagementGrant => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.authority !== "account" && candidate.authority !== "consumer") return false;
  const principal = candidate.principal;
  if (typeof principal !== "object" || principal === null || Array.isArray(principal)) return false;
  const record = principal as Record<string, unknown>;
  return (
    typeof record.accountId === "string" &&
    typeof record.consumerId === "string" &&
    Array.isArray(record.scopes) &&
    record.scopes.every(scope => typeof scope === "string") &&
    typeof record.expiresAt === "number" &&
    typeof record.issuer === "string" &&
    typeof record.audience === "string"
  );
};

type SourceRow = { readonly id: string; readonly url: string };
type OwnerRow = { readonly accounts: number; readonly consumers: number };
type StoredSubscriptionRow = { readonly source_id: string; readonly interval_hours: number };

const STORAGE_FAILURE = "subscription_mutation_failed";

const storageFailure = (cause?: unknown): SubscriptionMutationError =>
  new SubscriptionMutationError("storage_failure", STORAGE_FAILURE, cause === undefined ? undefined : { cause });

const asArray = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null);

type MutationContext = {
  readonly accountId: string;
  readonly consumerId: string;
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly createdAt: string;
};

/**
 * Account-level statements. The write is conditional on the acting consumer
 * still existing and on the stored source still having the exact URL that was
 * approved in the pre-read; the batch is one D1 transaction, so a concurrent
 * delete/change cannot leave a half-applied mutation.
 *
 * `ON CONFLICT ... DO UPDATE ... WHERE interval_hours <> excluded.interval_hours`
 * makes a repeated identical upsert a real no-op (`meta.changes = 0`) instead
 * of rewriting `created_at` or reporting a false change.
 */
const accountStatements = (
  db: D1Database,
  mutation: Extract<ParsedMutation, { level: "account" }>,
  context: MutationContext,
): D1PreparedStatement[] => {
  const write = mutation.op === "upsert"
    ? db.prepare(`
        INSERT INTO guanlan_account_subscriptions(account_id, source_id, interval_hours, created_at)
        SELECT c.account_id, s.id, ?, ?
          FROM guanlan_consumers c
          JOIN poc_sources s ON s.id = ? AND s.url = ?
         WHERE c.account_id = ? AND c.consumer_id = ?
        ON CONFLICT(account_id, source_id) DO UPDATE SET
          interval_hours = excluded.interval_hours
        WHERE guanlan_account_subscriptions.interval_hours <> excluded.interval_hours
      `).bind(
        mutation.intervalHours,
        context.createdAt,
        context.sourceId,
        context.sourceUrl,
        context.accountId,
        context.consumerId,
      )
    : db.prepare(`
        DELETE FROM guanlan_account_subscriptions
         WHERE account_id = ? AND source_id = ?
           AND EXISTS (SELECT 1 FROM poc_sources s WHERE s.id = ? AND s.url = ?)
           AND EXISTS (
             SELECT 1 FROM guanlan_consumers c
              WHERE c.account_id = ? AND c.consumer_id = ?
           )
      `).bind(
        context.accountId,
        context.sourceId,
        context.sourceId,
        context.sourceUrl,
        context.accountId,
        context.consumerId,
      );

  return [
    write,
    db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM guanlan_accounts WHERE account_id = ?) AS accounts,
        (SELECT COUNT(*) FROM guanlan_consumers
          WHERE account_id = ? AND consumer_id = ?) AS consumers
    `).bind(context.accountId, context.accountId, context.consumerId),
    db.prepare("SELECT id, url FROM poc_sources WHERE id = ?").bind(context.sourceId),
    db.prepare(`
      SELECT source_id, interval_hours
        FROM guanlan_account_subscriptions
       WHERE account_id = ? AND source_id = ?
    `).bind(context.accountId, context.sourceId),
  ];
};

/**
 * Consumer-level statements. The target consumer is always the acting
 * consumer; there is no consumer-id input, so a DTO cannot select a sibling
 * consumer or another tenant. The composite FK remains the final authority.
 */
const consumerStatements = (
  db: D1Database,
  mutation: Extract<ParsedMutation, { level: "consumer" }>,
  context: MutationContext,
): D1PreparedStatement[] => {
  const write = mutation.op === "upsert"
    ? db.prepare(`
        INSERT INTO guanlan_consumer_subscriptions(account_id, consumer_id, source_id, interval_hours, created_at)
        SELECT c.account_id, c.consumer_id, s.id, ?, ?
          FROM guanlan_consumers c
          JOIN poc_sources s ON s.id = ? AND s.url = ?
         WHERE c.account_id = ? AND c.consumer_id = ?
        ON CONFLICT(account_id, consumer_id, source_id) DO UPDATE SET
          interval_hours = excluded.interval_hours
        WHERE guanlan_consumer_subscriptions.interval_hours <> excluded.interval_hours
      `).bind(
        mutation.intervalHours,
        context.createdAt,
        context.sourceId,
        context.sourceUrl,
        context.accountId,
        context.consumerId,
      )
    : db.prepare(`
        DELETE FROM guanlan_consumer_subscriptions
         WHERE account_id = ? AND consumer_id = ? AND source_id = ?
           AND EXISTS (SELECT 1 FROM poc_sources s WHERE s.id = ? AND s.url = ?)
           AND EXISTS (
             SELECT 1 FROM guanlan_consumers c
              WHERE c.account_id = ? AND c.consumer_id = ?
           )
      `).bind(
        context.accountId,
        context.consumerId,
        context.sourceId,
        context.sourceId,
        context.sourceUrl,
        context.accountId,
        context.consumerId,
      );

  return [
    write,
    db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM guanlan_accounts WHERE account_id = ?) AS accounts,
        (SELECT COUNT(*) FROM guanlan_consumers
          WHERE account_id = ? AND consumer_id = ?) AS consumers
    `).bind(context.accountId, context.accountId, context.consumerId),
    db.prepare("SELECT id, url FROM poc_sources WHERE id = ?").bind(context.sourceId),
    db.prepare(`
      SELECT source_id, interval_hours
        FROM guanlan_consumer_subscriptions
       WHERE account_id = ? AND consumer_id = ? AND source_id = ?
    `).bind(context.accountId, context.consumerId, context.sourceId),
  ];
};

/**
 * Reads the four-statement batch back. A missing subject, a vanished/changed
 * source or a row that does not match the statement contract is decided here;
 * anything unexpected is a storage failure, never a silent success.
 */
const interpretBatch = (
  results: D1Result<unknown>[],
  mutation: ParsedMutation,
  context: MutationContext,
): { readonly changed: boolean } | { readonly failure: SubscriptionMutationFailure } => {
  if (!Array.isArray(results) || results.length !== 4) throw storageFailure();
  const [write, owner, source, row] = results;
  if (!write?.success || !owner?.success || !source?.success || !row?.success) {
    throw storageFailure();
  }

  const changes = write.meta?.changes;
  if (typeof changes !== "number") throw storageFailure();

  const ownerRows = asArray(owner.results);
  if (ownerRows === null || ownerRows.length !== 1) throw storageFailure();
  const ownerRecord = ownerRows[0] as Partial<OwnerRow>;
  if (typeof ownerRecord.accounts !== "number" || typeof ownerRecord.consumers !== "number") {
    throw storageFailure();
  }
  if (ownerRecord.accounts === 0) return { failure: "account_not_found" };
  if (ownerRecord.consumers === 0) return { failure: "consumer_not_found" };

  const sourceRows = asArray(source.results);
  if (sourceRows === null || sourceRows.length !== 1) return { failure: "source_not_found" };
  const sourceRecord = sourceRows[0] as Partial<SourceRow>;
  if (sourceRecord.id !== context.sourceId) throw storageFailure();
  if (sourceRecord.url !== context.sourceUrl) return { failure: "source_not_approved" };

  const storedRows = asArray(row.results);
  if (storedRows === null) throw storageFailure();

  if (mutation.op === "upsert") {
    if (storedRows.length !== 1) throw storageFailure();
    const stored = storedRows[0] as Partial<StoredSubscriptionRow>;
    if (stored.source_id !== context.sourceId || stored.interval_hours !== mutation.intervalHours) {
      throw storageFailure();
    }
    return { changed: changes === 1 };
  }

  if (storedRows.length !== 0) throw storageFailure();
  return { changed: changes === 1 };
};

/**
 * D1 implementation. Every mutation runs one pre-read (source admission) plus
 * one transactional four-statement batch, then reuses the GLN-006 reader for
 * the effective view. It never writes `poc_sources`, interests, consumer state
 * or scheduling fields.
 */
export function createD1SubscriptionMutator(
  db: D1Database,
  now: () => number = Date.now,
): GuanlanSubscriptionMutator {
  return {
    async mutate(grant: GuanlanManagementGrant, input: unknown): Promise<SubscriptionMutationResult> {
      if (!isGrant(grant)) return { ok: false, failure: "forbidden" };

      const mutation = parseMutation(input);
      if (mutation === null) return { ok: false, failure: "invalid_input" };

      if (mutation.level === "account" && grant.authority !== "account") {
        return { ok: false, failure: "forbidden" };
      }
      if (mutation.level === "consumer" && grant.authority !== "consumer") {
        return { ok: false, failure: "forbidden" };
      }

      let subject: GuanlanSubject;
      try {
        subject = subjectFromPrincipal(grant.principal);
      } catch {
        return { ok: false, failure: "forbidden" };
      }

      // Admission pre-read: the source must really exist and its stored URL
      // must still pass the GLN-008 exact-allowlist policy. A historical
      // `poc_sources` row with an arbitrary URL is not an approved source.
      let sourceRow: SourceRow | null;
      try {
        sourceRow = await db.prepare("SELECT id, url FROM poc_sources WHERE id = ?")
          .bind(mutation.sourceId)
          .first<SourceRow>();
      } catch (error) {
        throw storageFailure(error);
      }
      if (!sourceRow || sourceRow.id !== mutation.sourceId) {
        return { ok: false, failure: "source_not_found" };
      }
      const decision = evaluateSourceUrl(sourceRow.url);
      if (!decision.ok) return { ok: false, failure: "source_not_approved" };

      const context: MutationContext = {
        accountId: subject.accountId,
        consumerId: subject.consumerId,
        sourceId: mutation.sourceId,
        sourceUrl: sourceRow.url,
        createdAt: new Date(now()).toISOString(),
      };
      const statements = mutation.level === "account"
        ? accountStatements(db, mutation, context)
        : consumerStatements(db, mutation, context);

      let results: D1Result<unknown>[];
      try {
        results = await db.batch(statements);
      } catch (error) {
        throw storageFailure(error);
      }

      const outcome = interpretBatch(results, mutation, context);
      if ("failure" in outcome) return { ok: false, failure: outcome.failure };

      // Reuse the GLN-006 reader instead of computing a second effective view.
      // The write is already committed; a read failure is surfaced as a storage
      // error rather than as a successful mutation with an invented state.
      let read: SubscriptionReadResult;
      try {
        read = await createD1SubscriptionReader(db).read(subject);
      } catch (error) {
        throw storageFailure(error);
      }
      if (!read.ok) throw storageFailure();

      return {
        ok: true,
        changed: outcome.changed,
        level: mutation.level,
        sourceId: mutation.sourceId,
        intervalHours: mutation.op === "remove" ? null : mutation.intervalHours,
        effective: read.effective,
      };
    },
  };
}
