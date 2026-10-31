// GLN-003-only scheduled profiling harness. NEVER use as a production entrypoint.
// All meaningful work calls the SAME fetchLimited, parseWithFastXml and collectDue
// functions as the production Worker. There is no public benchmark HTTP endpoint.
import app from "../src/index";
import { collectDue, fetchLimited, type PocEnv } from "../src/ingest";
import { parseWithFastXml } from "../src/parser";

const SOURCE_ID = "gln003-cf-status";
const SOURCE_URL = "https://www.cloudflarestatus.com/history.atom";
const PLAN_ID = "gln003-profile-v1";
const MAX_RUNS = 9;

type ProfilePlan = { run: number };
type ProfileSource = { url: string };
type Mode = "fetch" | "parse" | "full";

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: PocEnv, _ctx: ExecutionContext) {
    // The profiling table exists ONLY in the isolated canary D1. Without the
    // table the Worker fails closed; production databases are never altered.
    const plan = await env.DB.prepare(`
      UPDATE gln003_profile_plan SET run = run + 1
      WHERE id=? AND run < ?
      RETURNING run
    `).bind(PLAN_ID, MAX_RUNS).first<ProfilePlan>();
    if (!plan) return; // hard cap, no repeat fetches after the experiment
    const source=await env.DB.prepare("SELECT url FROM poc_sources WHERE id=?")
      .bind(SOURCE_ID).first<ProfileSource>();
    if (source?.url !== SOURCE_URL) throw new Error("unexpected_canary_source");

    const mode: Mode = (["fetch","parse","full"] as const)[(plan.run - 1) % 3];
    const start = Date.now();
    let articles = 0, inserted = 0, success = false;
    let errorCode = "";
    try {
      if (mode === "full") {
        // Explicit test-only reset so every full run enters the *real*
        // production ingestion path. This adds one D1 UPDATE to its CPU;
        // report that bias. Do NOT delete articles or weaken URL dedup.
        const ready = await env.DB.prepare(`
          UPDATE poc_sources SET due_at=?
          WHERE id=? AND lease_token IS NULL
        `).bind("1970-01-01T00:00:00.000Z",SOURCE_ID).run();
        if (ready.meta.changes !== 1) throw new Error("source_not_released");
        const outcome=await collectDue(env,event.scheduledTime);
        if (outcome.processed !== 1 || outcome.errors !== 0 || outcome.leaseConflicts !== 0)
          throw new Error("full_ingest_incomplete");
        inserted=outcome.inserted;
      } else {
        const text=await fetchLimited(SOURCE_URL,req=>
          env.TEST_FEED_FETCHER ? env.TEST_FEED_FETCHER.fetch(req) : fetch(req));
        if (mode === "parse") {
          articles=parseWithFastXml(text,SOURCE_URL).length;
          if (!articles) throw new Error("empty_feed");
        } else {
          articles=text.length; // number of UTF-16 code units, not article count
        }
      }
      success=true;
    } catch(err) {
      errorCode=err instanceof Error && ["source_not_released","full_ingest_incomplete","empty_feed"].includes(err.message)
        ? err.message : "upstream_or_runtime_failure";
    }
    const durationMs=Date.now()-start;
    await env.DB.prepare(`
      INSERT INTO gln003_profile_samples(run,mode,success,articles,inserted,wall_ms,error_code)
      VALUES (?,?,?,?,?,?,?)
    `).bind(plan.run,mode,success?1:0,articles,inserted,durationMs,errorCode).run();
    // Mode lives in the app log and D1 so it can be matched to Cloudflare's
    // REAL cpuTimeMs for the scheduled invocation. Never log URL, token or XML.
    console.log(JSON.stringify({
      event:"gln003_cpu_profile",run:plan.run,mode,
      success,articles,inserted,durationMs,errorCode
    }));
  }
};
