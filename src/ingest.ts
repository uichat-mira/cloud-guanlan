import { parseWithFastXml } from "./parser";
import {
  INVOCATION_WALL_BUDGET_MS, LEASE_MS, MAX_FEED_BYTES,
  MAX_SOURCES_PER_INVOCATION, SOURCE_TIMEOUT_MS, nextFailureAt, nextSuccessAt
} from "./scheduler";

type Source = { id: string; url: string; interval_hours: number; retry_count: number; lease_token: string };
type Binding = { fetch(request: Request): Promise<Response> };
export type PocEnv = { DB: D1Database; TEST_FEED_FETCHER?: Binding };
export type CollectOutcome = {
  processed: number; inserted: number; errors: number;
  leaseConflicts: number; recovered: number; retries: number;
  backlog: number; oldestOverdueSeconds: number;
  durationMs: number; cpuMs: null;
};

const iso = (t:number) => new Date(t).toISOString();
const safeFailure = (error:unknown): string => {
  if (!(error instanceof Error)) return "unknown_failure";
  if (/^feed_http_[0-9]{3}$/.test(error.message)) return error.message;
  if (["feed_too_large", "invalid_source", "empty_body", "empty_feed", "unsupported_redirect"].includes(error.message)) return error.message;
  if (error.name === "AbortError" || error.name === "TimeoutError") return "fetch_timeout";
  return "fetch_or_parse_error"; // never persist arbitrary upstream URLs, tokens, or response content
};

export async function fetchLimited(urlString:string, fetcher:(req:Request)=>Promise<Response>):Promise<string> {
  const u = new URL(urlString);
  if (u.protocol !== "https:" || u.username || u.password ||
      u.hostname === "localhost" || u.hostname.endsWith(".local")) throw new Error("invalid_source");
  // Untrusted source URLs still require complete DNS/IP/SSRF hardening before user-facing ingestion.
  // Redirects are not followed; the fetch is aborted on a fixed wall deadline.
  const request = new Request(urlString, {
    redirect: "manual",
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }
  });
  const response = await fetcher(request);
  if (response.status >= 300 && response.status < 400) throw new Error("unsupported_redirect");
  if (!response.ok) throw new Error("feed_http_" + response.status);
  if (Number(response.headers.get("content-length") || 0) > MAX_FEED_BYTES) throw new Error("feed_too_large");
  if (!response.body) throw new Error("empty_body");
  const reader = response.body.getReader();
  const chunks:Uint8Array[] = [];
  let total = 0;
  try {
    while(true) {
      const {done,value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FEED_BYTES) throw new Error("feed_too_large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(()=>undefined); }
  const bytes = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) { bytes.set(chunk,cursor); cursor += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

// One SQLite UPDATE is both the eligibility check and the claim. No
// SELECT -> UPDATE gap; caller receives the token only if the lease was won.
async function claimDue(db:D1Database, now:number):Promise<Source|null> {
  const token=crypto.randomUUID();
  const stamp=iso(now);
  const claimed=await db.prepare(`
    UPDATE poc_sources SET lease_token=?,lease_expires_at=?
    WHERE id=(
      SELECT id FROM poc_sources
      WHERE due_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      ORDER BY due_at ASC,id ASC LIMIT 1
    ) AND due_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    RETURNING id,url,interval_hours,retry_count,lease_token
  `).bind(token,iso(now+LEASE_MS),stamp,stamp,stamp,stamp).first<Source>();
  return claimed ?? null;
}

async function persistSuccess(env:PocEnv, source:Source, now:number, news:ReturnType<typeof parseWithFastXml>):Promise<{inserted:number;lost:boolean}> {
  const stamp=iso(now);
  // One D1 batch is a transaction. Every insert requires current lease
  // ownership; even a delayed former holder cannot publish its old result.
  // JSON1 expands a bounded candidate list inside SQLite: two D1 statements
  // regardless of the number of entries, instead of preparing one INSERT per
  // article. Keep the lease predicate INSIDE the INSERT for stale-owner fencing.
  const batchItems = JSON.stringify(news.map(item => [item.url,item.title,item.summary,item.publishedAt]));
  const statements = [
    env.DB.prepare(`
      INSERT OR IGNORE INTO poc_news (url,source_id,title,summary,published_at,ingested_at)
      SELECT
        json_extract(entry.value, '$[0]'), ?,
        json_extract(entry.value, '$[1]'),
        json_extract(entry.value, '$[2]'),
        json_extract(entry.value, '$[3]'), ?
      FROM json_each(?) AS entry
      WHERE EXISTS (
        SELECT 1 FROM poc_sources
        WHERE id=? AND lease_token=? AND lease_expires_at > ?
      )
    `).bind(source.id,stamp,batchItems,source.id,source.lease_token,stamp),
    env.DB.prepare(`
      UPDATE poc_sources SET
        due_at=?,last_status='succeeded',last_error=NULL,last_checked_at=?,
        retry_count=0,lease_token=NULL,lease_expires_at=NULL
      WHERE id=? AND lease_token=? AND lease_expires_at > ?
    `).bind(nextSuccessAt(now,source.interval_hours),stamp,source.id,source.lease_token,stamp)
  ];
  const result=await env.DB.batch(statements);
  const released=result[result.length-1]?.meta?.changes;
  if (released !== 1) return {inserted:0,lost:true};
  return {inserted:result.slice(0,-1).reduce((n,r)=>n+(r.meta?.changes??0),0),lost:false};
}
async function persistFailure(env:PocEnv,source:Source,now:number,error:unknown):Promise<boolean> {
  const stamp=iso(now);
  const result=await env.DB.prepare(`
    UPDATE poc_sources SET due_at=?,last_status='failed',last_error=?,last_checked_at=?,
      retry_count=retry_count+1,lease_token=NULL,lease_expires_at=NULL
    WHERE id=? AND lease_token=? AND lease_expires_at > ?
  `).bind(nextFailureAt(now,source.retry_count,source.id),safeFailure(error),stamp,source.id,source.lease_token,stamp).run();
  return result.meta.changes === 1;
}

/** Called by Cron only, never by GET. All source work is sequential and bounded. */
export async function collectDue(env:PocEnv,_scheduledTime:number):Promise<CollectOutcome> {
  const wallStart=Date.now();
  // scheduledTime is event metadata, not the time work actually starts.
  // Cron delivery can be delayed; lease ownership and next-due timestamps
  // must always use actual wall time to prevent immediately expired claims.
  const actualNow=()=>Date.now();
  let processed=0,inserted=0,errors=0,leaseConflicts=0,recovered=0,retries=0;
  for(let i=0;i<MAX_SOURCES_PER_INVOCATION;i++) {
    if(Date.now()-wallStart >= INVOCATION_WALL_BUDGET_MS) break;
    const source=await claimDue(env.DB,actualNow());
    if (!source) break;
    if(source.retry_count>0) retries++;
    processed++;
    let news:ReturnType<typeof parseWithFastXml>;
    try {
      const xml=await fetchLimited(source.url,req=>env.TEST_FEED_FETCHER?env.TEST_FEED_FETCHER.fetch(req):fetch(req));
      news=parseWithFastXml(xml,source.url);
      if(!news.length) throw new Error("empty_feed");
    } catch(error) {
      const ok=await persistFailure(env,source,actualNow(),error);
      if(!ok) {leaseConflicts++;continue;}
      errors++;
      continue;
    }
    // Persistence failures propagate and preserve the lease for expiry/retry:
    // they are not reclassified as upstream fetch errors.
    const result=await persistSuccess(env,source,actualNow(),news);
    if(result.lost) {leaseConflicts++;continue;}
    inserted+=result.inserted;
    if(source.retry_count>0) recovered++;
  }
  const now=actualNow();
  const pending=await env.DB.prepare(`
    SELECT COUNT(*) AS n, MIN(due_at) AS oldest FROM poc_sources
    WHERE due_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
  `).bind(iso(now),iso(now)).first<{n:number;oldest:string|null}>();
  return {
    processed, inserted, errors, leaseConflicts, recovered, retries,
    backlog:pending?.n??0,
    oldestOverdueSeconds:pending?.oldest?Math.max(0,Math.floor((now-Date.parse(pending.oldest))/1000)):0,
    durationMs:Date.now()-wallStart,
    cpuMs:null // Cloudflare billed CPU is not observable from local workerd performance.now
  };
}
