import { parseWithFastXml } from "./parser";
import {
  INVOCATION_WALL_BUDGET_MS, LEASE_MS, MAX_FEED_BYTES,
  MAX_SOURCES_PER_INVOCATION, SOURCE_TIMEOUT_MS, nextFailureAt, nextSuccessAt
} from "./scheduler";
import { evaluateSourceUrl } from "./source-safety";

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

// Every persisted failure is a closed enum: no source URL, token, response
// header or body content can reach D1 or logs through this path.
const SAFE_FAILURE_MESSAGES = new Set([
  "feed_too_large", "invalid_source", "empty_body", "empty_feed", "unsupported_redirect",
  "fetch_timeout",
  "source_url_invalid", "source_scheme_rejected", "source_userinfo_rejected",
  "source_host_rejected", "source_private_address", "source_ip_literal_rejected",
  "source_port_rejected", "source_not_approved"
]);
const safeFailure = (error:unknown): string => {
  if (!(error instanceof Error)) return "unknown_failure";
  if (/^feed_http_[0-9]{3}$/.test(error.message)) return error.message;
  if (SAFE_FAILURE_MESSAGES.has(error.message)) return error.message;
  if (error.name === "AbortError" || error.name === "TimeoutError") return "fetch_timeout";
  return "fetch_or_parse_error";
};

const FETCH_TIMEOUT = "fetch_timeout";

/**
 * Races one asynchronous step against the remaining wall budget. The original
 * promise always gets handlers attached, so a late rejection after the timeout
 * cannot surface as an unhandled rejection.
 */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(FETCH_TIMEOUT)), Math.max(1, timeoutMs));
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

export type FetchLimitedOptions = {
  /** Total wall budget for the response headers plus the entire body. */
  readonly timeoutMs?: number;
};

/**
 * The only network path for an untrusted source URL.
 *
 * Order matters: the shared `evaluateSourceUrl` policy runs before any Request
 * is constructed, so an unapproved or unsafe source never reaches the network.
 * The approved canonical URL is fetched with `redirect: "manual"` (3xx is an
 * error, never followed), and the body is bounded both by the declared
 * Content-Length and by a real streamed byte count, so a missing or lying
 * header cannot bypass the limit. A single wall deadline covers headers and
 * body; a stalled response is aborted and the reader is cancelled.
 */
export async function fetchLimited(
  urlString:string,
  fetcher:(req:Request)=>Promise<Response>,
  options:FetchLimitedOptions = {}
):Promise<string> {
  const decision = evaluateSourceUrl(urlString);
  if (!decision.ok) throw new Error(decision.reason);

  const timeoutMs = options.timeoutMs ?? SOURCE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid_source");
  const deadline = Date.now() + timeoutMs;

  const request = new Request(decision.canonicalUrl, {
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }
  });
  const response = await withDeadline(fetcher(request), timeoutMs);
  if (response.status >= 300 && response.status < 400) throw new Error("unsupported_redirect");
  if (!response.ok) throw new Error("feed_http_" + response.status);
  const declaredLength = response.headers.get("content-length");
  // An absent or non-numeric header is not trusted; the streamed count below
  // remains the authoritative limit either way.
  if (declaredLength !== null && Number(declaredLength) > MAX_FEED_BYTES) throw new Error("feed_too_large");
  if (!response.body) throw new Error("empty_body");
  const reader = response.body.getReader();
  const chunks:Uint8Array[] = [];
  let total = 0;
  try {
    while(true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(FETCH_TIMEOUT);
      const {done,value} = await withDeadline(reader.read(), remaining);
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
