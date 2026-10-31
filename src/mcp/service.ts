import type { GuanlanPrincipal } from "./auth";
import {
  NEWS_SOURCE_ID_MAX,
  NEWS_SUMMARY_MAX,
  NEWS_TITLE_MAX,
  NEWS_URL_MAX,
  type NewsItem,
} from "./capabilities";

export type NewsQuery = { limit: number };

/**
 * Typed business boundary shared by this first read-only MCP capability and
 * later source/news tools. It receives the verifier-derived principal even
 * though the current shared index has no per-user rows yet; callers must not
 * accept identity from tool arguments.
 */
export interface GuanlanNewsReader {
  listRecent(principal: GuanlanPrincipal, query: NewsQuery): Promise<NewsItem[]>;
}

type NewsRow = {
  url: string;
  source_id: string;
  title: string;
  summary: string;
  published_at: string | null;
  ingested_at: string;
};

const bounded = (value: string | null | undefined, max: number): string => {
  if (!value) return "";
  return value.length > max ? value.slice(0, max) : value;
};

/** Stable identity derives from the complete canonical URL, never a displayed prefix. */
async function stableNewsId(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return "gln:" + Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, "0")).join("");
};

export function createD1NewsReader(db: D1Database): GuanlanNewsReader {
  return {
    async listRecent(_principal: GuanlanPrincipal, query: NewsQuery): Promise<NewsItem[]> {
      const result = await db.prepare(`
        SELECT url, source_id, title, summary, published_at, ingested_at
        FROM poc_news
        ORDER BY ingested_at DESC, url ASC
        LIMIT ?
      `).bind(query.limit).all<NewsRow>();
      if (!result.success) throw new Error("d1_news_read_failed");
      return Promise.all((result.results ?? []).map(async row => {
        // Do not return a truncated article link as though it were fetchable,
        // and never collapse two distinct stored URLs onto one public news ID.
        if (row.url.length > NEWS_URL_MAX) throw new Error("news_url_too_long");
        return {
          id: await stableNewsId(row.url),
          title: bounded(row.title, NEWS_TITLE_MAX),
          summary: bounded(row.summary, NEWS_SUMMARY_MAX),
          url: row.url,
          sourceId: bounded(row.source_id, NEWS_SOURCE_ID_MAX),
          publishedAt: row.published_at ? bounded(row.published_at, 64) : null,
          ingestedAt: bounded(row.ingested_at, 64),
        };
      }));
    },
  };
}
