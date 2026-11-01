import { evaluateSourceUrl, type SourceRejectionReason } from "./source-safety";

/**
 * GLN-008 · controlled minimal source admission/registration contract.
 *
 * This is the only supported way for platform tooling to add a feed to the
 * shared collection table. It intentionally:
 * - accepts only maintainer-approved public feeds (the allowlist is compiled
 *   into `src/source-allowlist.ts`; there is no public registration endpoint);
 * - reuses the existing shared `poc_sources` table and its `url` UNIQUE
 *   constraint, so approving the same feed twice cannot create a second
 *   collection task;
 * - never writes account/consumer subscription data (`guanlan_*` tables);
 * - leaves scheduling state (`due_at`, leases, retry counters) to the existing
 *   scheduler.
 *
 * Source ids are derived deterministically from the canonical URL, so the same
 * feed has the same id across registrations and environments. The UNIQUE `url`
 * constraint remains the authority for deduplication; the id hash is a stable
 * convenience, not a security boundary.
 */

export type SourceRegistrationInput = {
  readonly url: string;
  readonly intervalHours: number;
};

export type SourceRegistrationFailure =
  | SourceRejectionReason
  | "source_interval_invalid"
  | "source_registration_failed";

export type SourceRegistrationResult =
  | {
      readonly ok: true;
      readonly sourceId: string;
      readonly url: string;
      /** Stored interval; an existing row keeps its value on duplicate approval. */
      readonly intervalHours: number;
      /** True only when this call inserted the row. */
      readonly created: boolean;
    }
  | { readonly ok: false; readonly reason: SourceRegistrationFailure };

export interface GuanlanSourceRegistry {
  register(input: unknown): Promise<SourceRegistrationResult>;
}

const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 24;
const SOURCE_ID_HASH_HEX = 16;

type SourceRow = { id: string; url: string; interval_hours: number };

const sourceIdFor = async (canonicalUrl: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalUrl));
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `src_${hex.slice(0, SOURCE_ID_HASH_HEX)}`;
};

const readInterval = (value: unknown): number | null =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= MIN_INTERVAL_HOURS &&
  value <= MAX_INTERVAL_HOURS
    ? value
    : null;

/**
 * D1 implementation. The insert is `ON CONFLICT DO NOTHING` so a concurrent or
 * repeated approval of the same canonical URL is a no-op; the following read
 * returns the single stored row either way. A duplicate approval does **not**
 * rewrite an existing interval, because registration is admission, not
 * scheduling configuration.
 */
export function createD1SourceRegistry(
  db: D1Database,
  now: () => number = Date.now,
): GuanlanSourceRegistry {
  return {
    async register(input: unknown): Promise<SourceRegistrationResult> {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return { ok: false, reason: "source_url_invalid" };
      }
      const candidate = input as Record<string, unknown>;
      if (typeof candidate.url !== "string") return { ok: false, reason: "source_url_invalid" };
      const intervalHours = readInterval(candidate.intervalHours);
      if (intervalHours === null) return { ok: false, reason: "source_interval_invalid" };

      const decision = evaluateSourceUrl(candidate.url);
      if (!decision.ok) return { ok: false, reason: decision.reason };

      const sourceId = await sourceIdFor(decision.canonicalUrl);
      const inserted = await db.prepare(`
        INSERT INTO poc_sources (id,url,interval_hours,due_at)
        VALUES (?,?,?,?)
        ON CONFLICT DO NOTHING
      `).bind(
        sourceId,
        decision.canonicalUrl,
        intervalHours,
        new Date(now()).toISOString(),
      ).run();

      const row = await db.prepare(
        "SELECT id,url,interval_hours FROM poc_sources WHERE url=?",
      ).bind(decision.canonicalUrl).first<SourceRow>();
      if (!row) return { ok: false, reason: "source_registration_failed" };

      return {
        ok: true,
        sourceId: row.id,
        url: row.url,
        intervalHours: row.interval_hours,
        created: inserted.meta.changes === 1,
      };
    },
  };
}
