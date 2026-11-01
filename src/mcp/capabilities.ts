import * as z from "zod/v4";

export const NEWS_TOOL_NAME = "guanlan_news_recent";
export const WHOAMI_TOOL_NAME = "guanlan_whoami";
export const NEWS_LIMIT_DEFAULT = 20;
export const NEWS_LIMIT_MAX = 50;

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

export type NewsItem = z.infer<typeof NEWS_ITEM_SCHEMA>;
export type NewsPage = z.infer<typeof NEWS_OUTPUT_SCHEMA>;
export type WhoamiResult = z.infer<typeof WHOAMI_OUTPUT_SCHEMA>;

export const NEWS_TOOL_DESCRIPTION =
  "Read a bounded page of news from the authenticated Cloud Guanlan index, restricted to the sources this verified " +
  "account and stable consumer may read. Identity comes only from the access token; arguments cannot select another " +
  "account or consumer. Without an explicit status filter only unread+pending items are returned; adopted/ignored are " +
  "history and must be requested. Results are ordered by ingested_at DESC, url ASC and paged with an opaque cursor that " +
  "is bound to this identity and filter set. `keyword` is literal (not topic classification). Read-only: it never " +
  "ingests news, writes consumer state or runs the collector; a storage or contract failure is an explicit error, " +
  "never an empty page.";

export const WHOAMI_TOOL_DESCRIPTION =
  "Report the verified Cloud Auth account and stable consumer identity attached to this MCP credential. " +
  "Identity comes only from the access token; tool arguments cannot select another account or consumer.";

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
