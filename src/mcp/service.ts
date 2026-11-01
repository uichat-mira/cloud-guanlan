import { canonicalNewsUrl } from "../parser";
import {
  createD1ConsumptionLedger,
  type GuanlanConsumptionLedger,
} from "../consumption";
import {
  createD1SubscriptionReader,
  subjectFromPrincipal,
  type GuanlanSubject,
  type GuanlanSubscriptionReader,
} from "../subscriptions";
import type { GuanlanPrincipal } from "./auth";
import {
  NEWS_CURSOR_MAX,
  NEWS_DEFAULT_STATUSES,
  NEWS_KEYWORD_MAX,
  NEWS_KEYWORD_TERM_MAX,
  NEWS_KEYWORD_TERMS_MAX,
  NEWS_LIMIT_DEFAULT,
  NEWS_LIMIT_MAX,
  NEWS_SOURCE_ID_MAX,
  NEWS_STATUS_VALUES,
  NEWS_SUMMARY_MAX,
  NEWS_TIME_MAX,
  NEWS_TITLE_MAX,
  NEWS_URL_MAX,
  type NewsItem,
  type NewsPage,
  type NewsStatus,
} from "./capabilities";

/**
 * GLN-009 · authorized, paginated MCP news reading.
 *
 * One question only: *which news may this verified account × consumer read now,
 * in a stable page?* The verified `GuanlanPrincipal` is the sole identity input;
 * GLN-006 supplies the effective source set and GLN-007 supplies the per-consumer
 * decision ledger. Nothing here writes: no `pending` on read, no Cron, no ingest.
 *
 * Storage reality that shapes the query (see the GLN-009 engineering note):
 * `poc_news` is keyed by canonical URL while the ledger is keyed by its SHA-256
 * fingerprint, and D1's SQLite has no SHA-256 function (verified: `no such
 * function: sha256`). The status predicate therefore cannot be a SQL join without
 * changing a shared storage contract. The reader keeps every SQL-expressible
 * filter (source set, source id, ingested/published range, literal keyword,
 * stable order, keyset cursor) in SQL, scans a bounded number of chunks, applies
 * the status predicate through GLN-007, and returns a cursor for the last row it
 * *scanned* — so paging stays exact (no duplicate, no omission) while each
 * request has a hard scan budget.
 */

export type NewsQuery = {
  readonly limit?: number;
  readonly cursor?: string;
  readonly sourceId?: string;
  readonly status?: readonly NewsStatus[];
  readonly keyword?: string;
  readonly ingestedAfter?: string;
  readonly ingestedBefore?: string;
  readonly publishedAfter?: string;
  readonly publishedBefore?: string;
};

/** Hard per-request work bound: at most 8 chunks × 50 rows are examined. */
export const NEWS_SCAN_CHUNK = 50;
export const NEWS_SCAN_CHUNK_MAX = 8;

export type NewsReadFailureCode =
  | "invalid_subject"
  | "principal_unavailable"
  | "storage_failure"
  | "invalid_cursor"
  | "invalid_query"
  | "row_outside_contract";

/**
 * Thrown when a truthful page is impossible: unusable identity, unprovisioned
 * space, malformed/foreign cursor, out-of-contract query or a failed D1 read.
 * Never downgraded to an empty page.
 */
export class NewsReadError extends Error {
  readonly code: NewsReadFailureCode;

  constructor(code: NewsReadFailureCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NewsReadError";
    this.code = code;
  }
}

export interface GuanlanNewsReader {
  listPage(principal: GuanlanPrincipal, query: NewsQuery): Promise<NewsPage>;
}

type NewsRow = {
  readonly url: string;
  readonly source_id: string;
  readonly title: string;
  readonly summary: string;
  readonly published_at: string | null;
  readonly ingested_at: string;
};

type CursorPosition = { readonly ingestedAt: string; readonly url: string };

type NormalizedNewsQuery = {
  readonly limit: number;
  readonly statuses: readonly NewsStatus[];
  readonly sourceId: string | null;
  readonly terms: readonly string[];
  readonly ingestedAfter: string | null;
  readonly ingestedBefore: string | null;
  readonly publishedAfter: string | null;
  readonly publishedBefore: string | null;
  readonly cursor: string | null;
};

const encoder = new TextEncoder();

const invalidQuery = (message: string): NewsReadError =>
  new NewsReadError("invalid_query", message);

const invalidCursor = (message: string): NewsReadError =>
  new NewsReadError("invalid_cursor", message);

const storageFailure = (message: string, cause?: unknown): NewsReadError =>
  new NewsReadError("storage_failure", message, { cause });

const rowOutsideContract = (message: string): NewsReadError =>
  new NewsReadError("row_outside_contract", message);

const isNewsStatus = (value: unknown): value is NewsStatus =>
  typeof value === "string" && (NEWS_STATUS_VALUES as readonly string[]).includes(value);

const asciiFold = (value: string): string =>
  value.replace(/[A-Z]/g, letter => letter.toLowerCase());

const bounded = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

/** ISO-8601 instant normalized to the collector's stored `toISOString()` form. */
const normalizeInstant = (value: unknown, field: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > NEWS_TIME_MAX) {
    throw invalidQuery(`${field} must be a bounded ISO 8601 timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw invalidQuery(`${field} is not a valid ISO 8601 timestamp`);
  return new Date(millis).toISOString();
};

/**
 * Literal term list. Terms are split on whitespace and combined with AND; the
 * match itself is SQLite `LIKE`, i.e. ASCII-case-insensitive substring. No topic
 * classification is inferred: `topic` interests never become a news predicate.
 */
const normalizeKeyword = (value: unknown): string[] => {
  if (value === undefined || value === null) return [];
  if (typeof value !== "string" || value.length < 1 || value.length > NEWS_KEYWORD_MAX) {
    throw invalidQuery("keyword is outside the supported bound");
  }
  const terms = value.trim().split(/\s+/).filter(Boolean);
  if (terms.length < 1 || terms.length > NEWS_KEYWORD_TERMS_MAX) {
    throw invalidQuery("keyword must contain 1 to " + NEWS_KEYWORD_TERMS_MAX + " terms");
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const term of terms) {
    if (term.length < 1 || term.length > NEWS_KEYWORD_TERM_MAX) {
      throw invalidQuery("a keyword term is outside the supported bound");
    }
    const folded = asciiFold(term);
    if (seen.has(folded)) continue;
    seen.add(folded);
    unique.push(term);
  }
  return unique;
};

const normalizeStatuses = (value: unknown): NewsStatus[] => {
  if (value === undefined || value === null) return [...NEWS_DEFAULT_STATUSES];
  if (!Array.isArray(value) || value.length < 1 || value.length > NEWS_STATUS_VALUES.length) {
    throw invalidQuery("status must be a non-empty subset of unread/pending/adopted/ignored");
  }
  const selected = new Set<NewsStatus>();
  for (const candidate of value) {
    if (!isNewsStatus(candidate)) {
      throw invalidQuery("status must be a non-empty subset of unread/pending/adopted/ignored");
    }
    selected.add(candidate);
  }
  return NEWS_STATUS_VALUES.filter(status => selected.has(status));
};

const normalizeSourceId = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > NEWS_SOURCE_ID_MAX ||
    value !== value.trim()
  ) {
    throw invalidQuery("sourceId is outside the supported bound");
  }
  return value;
};

/**
 * Validates and canonicalizes one query. Pure and synchronous so the caller can
 * reject a bad request before any D1 access.
 */
export function normalizeNewsQuery(query: NewsQuery): NormalizedNewsQuery {
  if (!query || typeof query !== "object") throw invalidQuery("query must be an object");

  const limit = query.limit ?? NEWS_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > NEWS_LIMIT_MAX) {
    throw invalidQuery("limit must be an integer between 1 and " + NEWS_LIMIT_MAX);
  }

  const statuses = normalizeStatuses(query.status);
  const sourceId = normalizeSourceId(query.sourceId);
  const terms = normalizeKeyword(query.keyword);
  const ingestedAfter = normalizeInstant(query.ingestedAfter, "ingestedAfter");
  const ingestedBefore = normalizeInstant(query.ingestedBefore, "ingestedBefore");
  const publishedAfter = normalizeInstant(query.publishedAfter, "publishedAfter");
  const publishedBefore = normalizeInstant(query.publishedBefore, "publishedBefore");
  if (ingestedAfter !== null && ingestedBefore !== null && ingestedAfter > ingestedBefore) {
    throw invalidQuery("ingestedAfter must not be later than ingestedBefore");
  }
  if (publishedAfter !== null && publishedBefore !== null && publishedAfter > publishedBefore) {
    throw invalidQuery("publishedAfter must not be later than publishedBefore");
  }

  let cursor: string | null = null;
  if (query.cursor !== undefined && query.cursor !== null) {
    if (typeof query.cursor !== "string" || query.cursor.length < 1 || query.cursor.length > NEWS_CURSOR_MAX) {
      throw invalidCursor("the cursor is outside the supported bound");
    }
    cursor = query.cursor;
  }

  return {
    limit,
    statuses,
    sourceId,
    terms,
    ingestedAfter,
    ingestedBefore,
    publishedAfter,
    publishedBefore,
    cursor,
  };
}

/**
 * Escapes the three `LIKE` metacharacters for the `ESCAPE '\'` clause, so a
 * keyword such as `100%_done` matches those characters literally instead of
 * acting as a wildcard.
 */
export const escapeLikeTerm = (term: string): string =>
  term.replace(/[\\%_]/g, character => "\\" + character);

export type NewsChunkQuery = { readonly sql: string; readonly params: readonly (string | number)[] };

/**
 * One bounded chunk of the scan. Every dynamic value is a bound parameter; only
 * fixed SQL fragments are concatenated. Filters all run before `LIMIT`, and the
 * keyset cursor keeps `(ingested_at DESC, url ASC)` stable across equal timestamps.
 */
export function buildNewsChunkQuery(
  filters: NormalizedNewsQuery,
  sourceIds: readonly string[],
  after: CursorPosition | null,
  chunkSize: number,
): NewsChunkQuery {
  const conditions: string[] = ["source_id IN (SELECT value FROM json_each(?))"];
  const params: (string | number)[] = [JSON.stringify(sourceIds)];

  if (filters.sourceId !== null) {
    conditions.push("source_id = ?");
    params.push(filters.sourceId);
  }
  if (filters.ingestedAfter !== null) {
    conditions.push("ingested_at >= ?");
    params.push(filters.ingestedAfter);
  }
  if (filters.ingestedBefore !== null) {
    conditions.push("ingested_at <= ?");
    params.push(filters.ingestedBefore);
  }
  if (filters.publishedAfter !== null) {
    conditions.push("published_at >= ?");
    params.push(filters.publishedAfter);
  }
  if (filters.publishedBefore !== null) {
    conditions.push("published_at <= ?");
    params.push(filters.publishedBefore);
  }
  for (const term of filters.terms) {
    conditions.push("(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')");
    const pattern = `%${escapeLikeTerm(term)}%`;
    params.push(pattern, pattern);
  }
  if (after !== null) {
    conditions.push("(ingested_at < ? OR (ingested_at = ? AND url > ?))");
    params.push(after.ingestedAt, after.ingestedAt, after.url);
  }
  params.push(chunkSize);

  return {
    sql: "SELECT url, source_id, title, summary, published_at, ingested_at " +
      "FROM poc_news WHERE " + conditions.join(" AND ") +
      " ORDER BY ingested_at DESC, url ASC LIMIT ?",
    params,
  };
}

const toBase64Url = (text: string): string => {
  const bytes = encoder.encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (value: string): string | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
};

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
};

/**
 * Digest binding a cursor to the verified subject and the exact filter set. It is
 * an integrity aid (a random edit is detected); authorization never depends on
 * it, because every request re-reads GLN-006 before touching news.
 */
export async function newsFilterDigest(
  subject: GuanlanSubject,
  filters: NormalizedNewsQuery,
): Promise<string> {
  return sha256Hex(JSON.stringify([
    subject.accountId,
    subject.consumerId,
    filters.sourceId,
    filters.statuses,
    filters.terms,
    filters.ingestedAfter,
    filters.ingestedBefore,
    filters.publishedAfter,
    filters.publishedBefore,
  ]));
}

const cursorDigest = async (
  version: number,
  accountId: string,
  consumerId: string,
  filterDigest: string,
  ingestedAt: string,
  url: string,
): Promise<string> => sha256Hex([version, accountId, consumerId, filterDigest, ingestedAt, url].join("\u0000"));

export async function encodeNewsCursor(
  subject: GuanlanSubject,
  filterDigest: string,
  position: CursorPosition,
): Promise<string> {
  const version = 1;
  const payload = {
    v: version,
    a: subject.accountId,
    c: subject.consumerId,
    f: filterDigest,
    t: position.ingestedAt,
    u: position.url,
    h: await cursorDigest(version, subject.accountId, subject.consumerId, filterDigest, position.ingestedAt, position.url),
  };
  return toBase64Url(JSON.stringify(payload));
}

/**
 * Decodes a cursor and proves it belongs to this subject and filter set. A cursor
 * from another identity, from a different filter set, tampered with or malformed
 * is an explicit `invalid_cursor`, never a silent page.
 */
export async function decodeNewsCursor(
  cursor: string,
  subject: GuanlanSubject,
  filterDigest: string,
): Promise<CursorPosition> {
  if (typeof cursor !== "string" || cursor.length < 1 || cursor.length > NEWS_CURSOR_MAX) {
    throw invalidCursor("the cursor is outside the supported bound");
  }
  const json = fromBase64Url(cursor);
  if (json === null || json.length > NEWS_CURSOR_MAX) throw invalidCursor("the cursor is not decodable");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw invalidCursor("the cursor is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidCursor("the cursor is not a cursor object");
  }
  const payload = parsed as Record<string, unknown>;
  if (payload.v !== 1) throw invalidCursor("unsupported cursor version");
  if (payload.a !== subject.accountId || payload.c !== subject.consumerId) {
    throw invalidCursor("the cursor belongs to another identity");
  }
  if (payload.f !== filterDigest) throw invalidCursor("the cursor belongs to another filter set");
  if (typeof payload.t !== "string" || payload.t.length < 1 || payload.t.length > 64) {
    throw invalidCursor("the cursor position is malformed");
  }
  if (typeof payload.u !== "string" || payload.u.length < 1 || payload.u.length > NEWS_URL_MAX) {
    throw invalidCursor("the cursor position is malformed");
  }
  if (typeof payload.h !== "string" || payload.h.length !== 64) {
    throw invalidCursor("the cursor integrity value is malformed");
  }
  const expected = await cursorDigest(1, subject.accountId, subject.consumerId, filterDigest, payload.t, payload.u);
  if (payload.h !== expected) throw invalidCursor("the cursor was modified");
  return { ingestedAt: payload.t, url: payload.u };
}

const readChunk = async (
  db: D1Database,
  sql: string,
  params: readonly (string | number)[],
): Promise<NewsRow[]> => {
  let result: D1Result<NewsRow>;
  try {
    result = await db.prepare(sql).bind(...params).all<NewsRow>();
  } catch (error) {
    throw storageFailure("the news index could not be read", error);
  }
  if (!result || !result.success || !Array.isArray(result.results)) {
    throw storageFailure("the news index returned an unexpected result");
  }
  return result.results.map(raw => {
    if (
      !raw || typeof raw !== "object" ||
      typeof raw.url !== "string" || raw.url.length < 1 ||
      typeof raw.source_id !== "string" || raw.source_id.length < 1 ||
      typeof raw.title !== "string" || typeof raw.summary !== "string" ||
      typeof raw.ingested_at !== "string" || raw.ingested_at.length < 1 || raw.ingested_at.length > 64 ||
      (raw.published_at !== null && typeof raw.published_at !== "string")
    ) {
      throw rowOutsideContract("a news row is outside the stored contract");
    }
    return raw;
  });
};

const readChunkStates = async (
  ledger: GuanlanConsumptionLedger,
  subject: GuanlanSubject,
  rows: readonly NewsRow[],
): Promise<Map<string, NewsStatus>> => {
  let result: Awaited<ReturnType<GuanlanConsumptionLedger["read"]>>;
  try {
    result = await ledger.read(subject, { urls: rows.map(row => row.url) });
  } catch (error) {
    throw storageFailure("the consumer state ledger could not be read", error);
  }
  if (!result.ok) {
    if (result.failure === "invalid_subject") {
      throw new NewsReadError("invalid_subject", "the verified principal is not a usable identity");
    }
    if (result.failure === "account_not_found" || result.failure === "consumer_not_found") {
      throw new NewsReadError("principal_unavailable", "the verified subject has no provisioned Guanlan space");
    }
    // news_not_found / source_not_authorized / invalid_request: a news row we just
    // read from an authorized source cannot be answered for. That is a storage or
    // contract anomaly, never an implied `unread`.
    throw storageFailure("the consumer state ledger could not answer for a stored news row");
  }
  const states = new Map<string, NewsStatus>();
  for (const state of result.states) states.set(state.url, state.status);
  return states;
};

const toNewsItem = (row: NewsRow, status: NewsStatus): NewsItem => {
  if (row.url.length > NEWS_URL_MAX) {
    throw rowOutsideContract("a news url exceeds the explicit output bound");
  }
  if (canonicalNewsUrl(row.url) !== row.url) {
    throw rowOutsideContract("a news url is not in the collector's canonical form");
  }
  if (row.source_id.length > NEWS_SOURCE_ID_MAX) {
    throw rowOutsideContract("a source id exceeds the explicit output bound");
  }
  return {
    id: row.url,
    title: bounded(row.title, NEWS_TITLE_MAX),
    summary: bounded(row.summary, NEWS_SUMMARY_MAX),
    url: row.url,
    // Never truncated: a shortened source id would name a different source.
    sourceId: row.source_id,
    publishedAt: row.published_at,
    ingestedAt: row.ingested_at,
    status,
  };
};

const emptyPage = (limit: number): NewsPage => ({ items: [], count: 0, limit, nextCursor: null });

export type NewsReaderDependencies = {
  readonly db: D1Database;
  readonly subscriptions: GuanlanSubscriptionReader;
  readonly ledger: GuanlanConsumptionLedger;
};

/**
 * Authorized reader over the shared index. Every call re-derives identity and
 * permission from the verified principal; the cursor only carries a position.
 */
export function createAuthorizedNewsReader(dependencies: NewsReaderDependencies): GuanlanNewsReader {
  const { db, subscriptions, ledger } = dependencies;

  return {
    async listPage(principal: GuanlanPrincipal, query: NewsQuery): Promise<NewsPage> {
      const filters = normalizeNewsQuery(query);

      let subject: GuanlanSubject;
      try {
        subject = subjectFromPrincipal(principal);
      } catch (error) {
        throw new NewsReadError("invalid_subject", "the verified principal is not a usable identity", {
          cause: error,
        });
      }

      let authorization: Awaited<ReturnType<GuanlanSubscriptionReader["read"]>>;
      try {
        authorization = await subscriptions.read(subject);
      } catch (error) {
        throw storageFailure("the effective subscription set could not be read", error);
      }
      if (!authorization.ok) {
        if (authorization.failure === "invalid_subject") {
          throw new NewsReadError("invalid_subject", "the verified principal is not a usable identity");
        }
        // account_not_found / consumer_not_found: the verified credential names a
        // subject without a provisioned Guanlan space. Explicit, but generic: it
        // never reveals whether some other account or consumer exists.
        throw new NewsReadError("principal_unavailable", "the verified subject has no provisioned Guanlan space");
      }

      const sourceIds = authorization.effective.sourceIds;
      // Zero effective sources is a positive answer, never "read every source".
      if (sourceIds.length === 0) return emptyPage(filters.limit);
      // An unauthorized source id is answered with an empty page, so the caller
      // cannot probe whether another source exists in the global index.
      if (filters.sourceId !== null && !sourceIds.includes(filters.sourceId)) {
        return emptyPage(filters.limit);
      }

      const digest = await newsFilterDigest(subject, filters);
      let after: CursorPosition | null = null;
      if (filters.cursor !== null) {
        after = await decodeNewsCursor(filters.cursor, subject, digest);
      }

      const items: NewsItem[] = [];
      let lastScanned: CursorPosition | null = after;
      let nextCursor: string | null = null;
      let finished = false;

      for (let chunkIndex = 0; chunkIndex < NEWS_SCAN_CHUNK_MAX && !finished; chunkIndex++) {
        const { sql, params } = buildNewsChunkQuery(filters, sourceIds, lastScanned, NEWS_SCAN_CHUNK);
        const rows = await readChunk(db, sql, params);
        if (rows.length === 0) {
          finished = true;
          break;
        }
        const states = await readChunkStates(ledger, subject, rows);

        let consumed = 0;
        for (; consumed < rows.length; consumed++) {
          const row = rows[consumed];
          lastScanned = { ingestedAt: row.ingested_at, url: row.url };
          const status = states.get(row.url);
          if (status === undefined) {
            throw rowOutsideContract("a stored news row has no answerable consumer state");
          }
          if (!filters.statuses.includes(status)) continue;
          items.push(toNewsItem(row, status));
          if (items.length === filters.limit) {
            consumed += 1;
            break;
          }
        }

        if (items.length === filters.limit) {
          const chunkExhausted = consumed >= rows.length;
          // A short chunk proves the end of the filtered stream. Otherwise more
          // rows may exist, so the cursor continues after the last scanned row.
          nextCursor = chunkExhausted && rows.length < NEWS_SCAN_CHUNK
            ? null
            : await encodeNewsCursor(subject, digest, lastScanned as CursorPosition);
          finished = true;
          break;
        }
        if (rows.length < NEWS_SCAN_CHUNK) {
          // The scan reached the end of the authorized news stream.
          finished = true;
          break;
        }
      }

      if (!finished && lastScanned !== null) {
        // The per-request scan budget was exhausted; the cursor continues after
        // the last scanned row so the next request resumes exactly there.
        nextCursor = await encodeNewsCursor(subject, digest, lastScanned);
      }

      return { items, count: items.length, limit: filters.limit, nextCursor };
    },
  };
}

/**
 * D1 wiring for the MCP runtime: GLN-006 for authorization, GLN-007 for status.
 * Constructing the reader performs no I/O.
 */
export function createD1NewsReader(db: D1Database): GuanlanNewsReader {
  const subscriptions = createD1SubscriptionReader(db);
  return createAuthorizedNewsReader({
    db,
    subscriptions,
    ledger: createD1ConsumptionLedger({ db, subscriptions }),
  });
}
