import * as z from "zod/v4";
import {
  CONSUMPTION_OPERATION_ID_MAX,
  CONSUMPTION_OUTCOME_URL_MAX,
  CONSUMPTION_REASON_MAX,
  CONSUMPTION_STATUSES,
} from "../consumption";

export const NEWS_TOOL_NAME = "guanlan_news_recent";
export const WHOAMI_TOOL_NAME = "guanlan_whoami";
export const DECIDE_TOOL_NAME = "guanlan_news_decide";
export const NEWS_LIMIT_DEFAULT = 20;
export const NEWS_LIMIT_MAX = 50;

/**
 * Writable decision states. `unread` is deliberately absent: it is the absence
 * of a GLN-007 ledger row, never a value a client may write.
 */
export const DECIDE_STATUS_VALUES = CONSUMPTION_STATUSES;
/** GLN-007 storage bounds, imported so schema and ledger can never drift. */
export const DECIDE_OPERATION_ID_MAX = CONSUMPTION_OPERATION_ID_MAX;
export const DECIDE_REASON_MAX = CONSUMPTION_REASON_MAX;
export const DECIDE_OUTCOME_URL_MAX = CONSUMPTION_OUTCOME_URL_MAX;

/** Tool output is bounded before it enters MCP schemas. */
export const NEWS_TITLE_MAX = 500;
export const NEWS_SUMMARY_MAX = 2_000;
export const NEWS_URL_MAX = 4_096;
/**
 * `poc_sources.id` has no length bound in `0001`; GLN-006 proved real ids can
 * exceed 128 characters. A source id is an identity, so it is never truncated:
 * a row beyond this explicit output budget fails the page instead of returning
 * a different-looking source.
 */
export const NEWS_SOURCE_ID_MAX = 2_048;

/** Effective consumer status. `unread` is the absence of a GLN-007 ledger row. */
export const NEWS_STATUS_VALUES = ["unread", "pending", "adopted", "ignored"] as const;
export type NewsStatus = (typeof NEWS_STATUS_VALUES)[number];
/** Product default: the consumer has not finished processing the item yet. */
export const NEWS_DEFAULT_STATUSES: readonly NewsStatus[] = ["unread", "pending"];

export const NEWS_KEYWORD_MAX = 200;
export const NEWS_KEYWORD_TERM_MAX = 64;
export const NEWS_KEYWORD_TERMS_MAX = 8;
export const NEWS_TIME_MAX = 64;
/**
 * An opaque cursor carries the last scanned `(ingested_at, url)` position plus
 * a binding digest. URLs may be long, so the encoded cursor has its own budget;
 * it is an integrity aid, never an authorization credential.
 */
export const NEWS_CURSOR_MAX = 12_000;

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * The one write tool is explicitly not read-only. It is idempotent because the
 * GLN-007 `operationId` replays an exact retry without a new version, and it is
 * not destructive because a decision is a versioned, reversible row update.
 */
export const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const DECIDE_TOOL_ERRORS = {
  /** Credential verified, but it does not carry the independent write scope. */
  forbidden: "guanlan_decision_forbidden",
  /** `expectedVersion` no longer matches the stored decision. */
  versionConflict: "guanlan_decision_version_conflict",
  /** The same `operationId` was already used for different decision content. */
  operationConflict: "guanlan_decision_operation_conflict",
  /**
   * The article is unknown or its source is not in this consumer's effective
   * set. The two are deliberately indistinguishable so the tool cannot probe
   * the global index or another account's subscriptions.
   */
  notAvailable: "guanlan_decision_not_available",
  /** Verified credential without a provisioned Cloud Guanlan space. */
  principalUnavailable: "guanlan_principal_unavailable",
  /** Request outside the documented bounds (direct domain calls only). */
  invalidRequest: "guanlan_decision_invalid",
  /** Storage/contract failure: never reported as a conflict or a denial. */
  unavailable: "guanlan_decision_unavailable",
} as const;

export const NEWS_TOOL_ERRORS = {
  /** Storage/contract failure: never downgraded to a plausible empty page. */
  unavailable: "guanlan_news_unavailable",
  /** Malformed, tampered or foreign cursor: explicit retry instruction. */
  cursorInvalid: "guanlan_news_cursor_invalid",
  /** Query outside the documented bounds (direct domain calls only). */
  queryInvalid: "guanlan_news_query_invalid",
  /** Verified credential whose Guanlan account/consumer space is not provisioned. */
  principalUnavailable: "guanlan_principal_unavailable",
} as const;

export const NEWS_INPUT_SCHEMA = z.object({
  limit: z.number().int().min(1).max(NEWS_LIMIT_MAX).optional()
    .describe("Maximum items in this page (1-50, default 20)."),
  cursor: z.string().min(1).max(NEWS_CURSOR_MAX).optional()
    .describe("Opaque nextCursor from a previous call. Bound to this verified identity and to the filter set."),
  sourceId: z.string().min(1).max(NEWS_SOURCE_ID_MAX).optional()
    .describe("Restrict to one source id from this consumer's effective subscription set."),
  status: z.array(z.enum(NEWS_STATUS_VALUES)).min(1).max(NEWS_STATUS_VALUES.length).optional()
    .describe("Effective consumer statuses to include. Defaults to unread+pending; adopted/ignored are history and must be asked for."),
  keyword: z.string().min(1).max(NEWS_KEYWORD_MAX).optional()
    .describe("Literal, case-insensitive (ASCII) term match over title and summary. Space-separated terms are combined with AND."),
  ingestedAfter: z.string().min(1).max(NEWS_TIME_MAX).optional()
    .describe("Inclusive lower bound on the collector's ingested_at timestamp (ISO 8601)."),
  ingestedBefore: z.string().min(1).max(NEWS_TIME_MAX).optional()
    .describe("Inclusive upper bound on ingested_at (ISO 8601)."),
  publishedAfter: z.string().min(1).max(NEWS_TIME_MAX).optional()
    .describe("Inclusive lower bound on the upstream published_at timestamp (ISO 8601); items without a published time are excluded."),
  publishedBefore: z.string().min(1).max(NEWS_TIME_MAX).optional()
    .describe("Inclusive upper bound on published_at (ISO 8601); items without a published time are excluded."),
});

export const NEWS_ITEM_SCHEMA = z.object({
  id: z.string().describe("Stable canonical article URL identifier (untruncated)."),
  title: z.string(),
  summary: z.string(),
  url: z.string(),
  sourceId: z.string(),
  publishedAt: z.string().nullable(),
  ingestedAt: z.string(),
  status: z.enum(NEWS_STATUS_VALUES),
  /**
   * CAS token for `guanlan_news_decide`: the stored GLN-007 decision version, or
   * `0` when the article is unread (no ledger row). Reading never writes it.
   */
  stateVersion: z.number().int().min(0),
});

export const NEWS_OUTPUT_SCHEMA = z.object({
  items: z.array(NEWS_ITEM_SCHEMA),
  count: z.number().int(),
  limit: z.number().int(),
  nextCursor: z.string().nullable(),
});

export const WHOAMI_OUTPUT_SCHEMA = z.object({
  accountId: z.string(),
  consumerId: z.string(),
  scopes: z.array(z.string()),
});

/**
 * The decision as stored by GLN-007. `version` is the ordering authority and the
 * next `expectedVersion`; `decidedAt` is a server-assigned observation time, not
 * a client clock and never an ordering input.
 */
export const DECISION_STATE_SCHEMA = z.object({
  url: z.string(),
  status: z.enum(DECIDE_STATUS_VALUES),
  version: z.number().int().min(1),
  sourceId: z.string().nullable(),
  reason: z.string().nullable(),
  outcomeUrl: z.string().nullable(),
  decidedAt: z.string().nullable(),
});

export const DECIDE_OUTPUT_SCHEMA = z.object({
  /** `updated` applied the decision; `replayed` recognised an exact retry. */
  result: z.enum(["updated", "replayed"]),
  state: DECISION_STATE_SCHEMA,
});

export const DECIDE_INPUT_SCHEMA = z.object({
  url: z.string().min(1).max(NEWS_URL_MAX)
    .describe("Canonical article URL exactly as returned by guanlan_news_recent (`id`/`url`). The collector's canonicalization is applied; a fragment never creates a new identity."),
  status: z.enum(DECIDE_STATUS_VALUES)
    .describe("Explicit decision: pending | adopted | ignored. `unread` is not writable; it is the absence of a decision."),
  expectedVersion: z.number().int().min(0)
    .describe("Compare-and-set precondition: the `stateVersion` last observed for this article. 0 means 'no decision yet'. A stale value is rejected, never silently overwritten."),
  operationId: z.string().min(1).max(DECIDE_OPERATION_ID_MAX)
    .describe("Idempotency key of this single decision (1-128 chars, no surrounding whitespace). Retry the same decision with the same id; a new decision needs a new id."),
  reason: z.string().min(1).max(DECIDE_REASON_MAX).optional()
    .describe("Optional bounded reason (1-500 chars, no surrounding whitespace)."),
  outcomeUrl: z.string().min(1).max(DECIDE_OUTCOME_URL_MAX).optional()
    .describe("Optional http(s) link to the result this decision produced."),
});

export type NewsItem = z.infer<typeof NEWS_ITEM_SCHEMA>;
export type NewsPage = z.infer<typeof NEWS_OUTPUT_SCHEMA>;
export type WhoamiResult = z.infer<typeof WHOAMI_OUTPUT_SCHEMA>;
export type DecisionState = z.infer<typeof DECISION_STATE_SCHEMA>;
export type DecisionResult = z.infer<typeof DECIDE_OUTPUT_SCHEMA>;

export const NEWS_TOOL_DESCRIPTION =
  "Read a bounded page of news from the authenticated Cloud Guanlan index, restricted to the sources this verified " +
  "account and stable consumer may read. Identity comes only from the access token; arguments cannot select another " +
  "account or consumer. Without an explicit status filter only unread+pending items are returned; adopted/ignored are " +
  "history and must be requested. Results are ordered by ingested_at DESC, url ASC and paged with an opaque cursor that " +
  "is bound to this identity and filter set. `keyword` is literal (not topic classification). Every item carries the " +
  "current decision `stateVersion` (0 = unread) to use as the `expectedVersion` precondition of guanlan_news_decide. " +
  "Read-only: it never ingests news, writes consumer state or runs the collector; a storage or contract failure is an " +
  "explicit error, never an empty page.";

export const WHOAMI_TOOL_DESCRIPTION =
  "Report the verified Cloud Auth account and stable consumer identity attached to this MCP credential. " +
  "Identity comes only from the access token; tool arguments cannot select another account or consumer.";

export const DECIDE_TOOL_DESCRIPTION =
  "Record one explicit consumption decision (pending | adopted | ignored) for one canonical news article, " +
  "reusing the durable GLN-007 account × consumer ledger. The caller identity (account, consumer) comes only " +
  "from the verified access token; arguments cannot select another account or consumer. Writing additionally " +
  "requires the independent `guanlan.write` scope: a read-only credential can call the read tools but can never " +
  "change state. Pass the `stateVersion` from guanlan_news_recent as `expectedVersion` (0 when unread) and a fresh " +
  "`operationId` for every article; the id is idempotent per article, so retrying the same decision with the same " +
  "id is a safe `replayed` no-op, a stale version is a `version_conflict` that never overwrites newer state, and " +
  "reusing the id for different content on the same article is an `operation_conflict`. An id reused on a " +
  "different article is a separate decision. Values outside the documented bounds (including surrounding " +
  "whitespace or a non-http(s) outcome link) are rejected as `guanlan_decision_invalid`. Unknown articles and " +
  "articles outside this consumer's authorized sources share one opaque `not_available` answer. Reading news " +
  "never writes a decision.";

export function renderNewsMarkdown(page: NewsPage): string {
  const lines = [
    `# Cloud Guanlan news · ${page.count} item(s)`,
    `Page size: ${page.limit} · Returned: ${page.count} · Next cursor: ${page.nextCursor ?? "none"}`,
  ];
  if (page.items.length === 0) {
    lines.push("",
      page.nextCursor
        ? "No matching news in this scanned window. More authorized news may exist; continue with the next cursor."
        : "No news items match this authorized query.",
    );
    return lines.join("\n");
  }
  for (const item of page.items) {
    lines.push(
      "",
      `## ${item.title}`,
      `Status: ${item.status}`,
      `State version: ${item.stateVersion}`,
      `Source: ${item.sourceId}`,
      `Published: ${item.publishedAt ?? "unknown"}`,
      `Ingested: ${item.ingestedAt}`,
      `URL: ${item.url}`,
      "",
      item.summary || "(no upstream summary)",
    );
  }
  return lines.join("\n");
}

/**
 * Success rendering for the write tool. The same `DecisionResult` object drives
 * `structuredContent`, so Markdown and JSON can never disagree on the decision
 * or on the version the client must use next.
 */
export function renderDecisionMarkdown(result: DecisionResult): string {
  const state = result.state;
  return [
    `# Cloud Guanlan decision · ${result.result}`,
    `Status: ${state.status}`,
    `Version: ${state.version}`,
    `URL: ${state.url}`,
    `Source: ${state.sourceId ?? "unknown"}`,
    `Reason: ${state.reason ?? "none"}`,
    `Outcome: ${state.outcomeUrl ?? "none"}`,
    `Decided at: ${state.decidedAt ?? "unknown"}`,
  ].join("\n");
}
