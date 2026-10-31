import { drizzle } from "drizzle-orm/d1";
import { pocNews } from "./schema";
import { parseWithFeedsmith } from "./parser";

type Source = { id: string; url: string; interval_hours: number };
type Binding = { fetch(request: Request): Promise<Response> };
export type PocEnv = { DB: D1Database; TEST_FEED_FETCHER?: Binding };

const MAX_BYTES = 128 * 1024;
const MAX_SOURCE_PER_TICK = 1;
const nextDueAt = (time: number, hours: number): string => new Date(time + hours * 3600_000).toISOString();
const errorString = (error: unknown): string => error instanceof Error ? error.message.slice(0, 240) : "unknown error";

async function fetchLimited(urlString: string, fetcher: (req: Request) => Promise<Response>): Promise<string> {
  const u = new URL(urlString);
  if (u.protocol !== "https:" || u.username || u.password || u.hostname === "localhost" || u.hostname.endsWith(".local")) {
    throw new Error("Invalid source URL");
  }
  // NO redirect following: POC only; DNS-rebinding / IP network protections still needed for public sources.
  const response = await fetcher(new Request(urlString, { redirect: "manual", headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" } }));
  if (!response.ok) throw new Error("Feed HTTP " + response.status);
  if (Number(response.headers.get("content-length") || 0) > MAX_BYTES) throw new Error("Feed oversized");
  if (!response.body) throw new Error("Empty response body");
  const reader = response.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) throw new Error("Feed oversized");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function collectDue(env: PocEnv, timestamp: number): Promise<{processed:number; inserted:number; errors:number}> {
  const now = new Date(timestamp).toISOString();
  const sources = await env.DB.prepare(
    "SELECT id, url, interval_hours FROM poc_sources WHERE due_at <= ? ORDER BY due_at, id LIMIT ?"
  ).bind(now, MAX_SOURCE_PER_TICK).all<Source>();
  let inserted = 0, errors = 0;
  for (const source of sources.results) {
    try {
      const xml = await fetchLimited(source.url, req => env.TEST_FEED_FETCHER ? env.TEST_FEED_FETCHER.fetch(req) : fetch(req));
      const news = parseWithFeedsmith(xml, source.url);
      if (!news.length) throw new Error("No usable feed items");
      // D1 + Drizzle integration; existing source is explicit and no user data is public.
      const db = drizzle(env.DB);
      for (const item of news) {
        const written = await db.insert(pocNews).values({
          url:item.url, title:item.title, summary:item.summary, sourceId:source.id,
          publishedAt:item.publishedAt, ingestedAt:now
        }).onConflictDoNothing().run();
        inserted += written.meta?.changes ?? 0;
      }
      await env.DB.prepare(
        "UPDATE poc_sources SET due_at=?,last_status='succeeded',last_error=NULL,last_checked_at=? WHERE id=?"
      ).bind(nextDueAt(timestamp, source.interval_hours),now,source.id).run();
    } catch (error) {
      errors += 1;
      await env.DB.prepare(
        "UPDATE poc_sources SET due_at=?,last_status='failed',last_error=?,last_checked_at=? WHERE id=?"
      ).bind(nextDueAt(timestamp,1),errorString(error),now,source.id).run();
    }
  }
  return {processed: sources.results.length, inserted, errors};
}
