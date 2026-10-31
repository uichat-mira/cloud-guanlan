import * as z from "zod/v4";

export const NEWS_TOOL_NAME = "guanlan_news_recent";
export const WHOAMI_TOOL_NAME = "guanlan_whoami";
export const NEWS_LIMIT_DEFAULT = 20;
export const NEWS_LIMIT_MAX = 50;

/** Tool output is bounded before it enters MCP schemas. */
export const NEWS_TITLE_MAX = 500;
export const NEWS_SUMMARY_MAX = 2_000;
export const NEWS_URL_MAX = 4_096;
export const NEWS_SOURCE_ID_MAX = 200;

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const NEWS_TOOL_ERRORS = {
  unavailable: "guanlan_news_unavailable",
} as const;

export const NEWS_INPUT_SCHEMA = z.object({
  limit: z.number().int().min(1).max(NEWS_LIMIT_MAX).optional()
    .describe("Maximum number of recent items to return (1-50, default 20)."),
});

export const NEWS_ITEM_SCHEMA = z.object({
  id: z.string().describe("Stable SHA-256 identifier derived from the complete canonical article URL."),
  title: z.string(),
  summary: z.string(),
  url: z.string(),
  sourceId: z.string(),
  publishedAt: z.string().nullable(),
  ingestedAt: z.string(),
});

export const NEWS_OUTPUT_SCHEMA = z.object({
  items: z.array(NEWS_ITEM_SCHEMA),
  count: z.number().int(),
  limit: z.number().int(),
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
  "Read a bounded page of recent news metadata from the authenticated Cloud Guanlan index. " +
  "This is read-only: it never triggers ingestion, changes subscriptions, or writes consumer state. " +
  "It returns news already stored by the collector; a collector or database failure is reported as an error, not an empty page.";

export const WHOAMI_TOOL_DESCRIPTION =
  "Report the verified Cloud Auth account and stable consumer identity attached to this MCP credential. " +
  "Identity comes only from the access token; tool arguments cannot select another account or consumer.";

export function renderNewsMarkdown(page: NewsPage): string {
  if (page.items.length === 0) return "No news items are stored in the authenticated index yet.";
  const lines = [`# Cloud Guanlan news · ${page.count} item(s)`];
  for (const item of page.items) {
    lines.push(
      "",
      `## ${item.title}`,
      `Source: ${item.sourceId}`,
      `Published: ${item.publishedAt ?? "unknown"}`,
      `URL: ${item.url}`,
      "",
      item.summary || "(no upstream summary)",
    );
  }
  return lines.join("\n");
}
