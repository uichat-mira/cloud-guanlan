import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Miniflare} from "miniflare";
import {rss} from "./fixtures.mjs";

const now=Date.now();
const overdue=new Date(now-60_000).toISOString();
const CRON="*/5 * * * *";
async function withWorker(fetcher,run){
  const mf=new Miniflare({
    modules:true,scriptPath:"dist/worker.mjs",compatibilityDate:"2026-08-06",cf:false,
    d1Databases:{DB:"00000000-0000-4000-8000-000000000002"},
    serviceBindings:{TEST_FEED_FETCHER:async req=>fetcher(req)}
  });
  try {
    const db=await mf.getD1Database("DB");
    for(const file of ["migrations/0001_poc.sql","migrations/0002_source_leases.sql"]){
      const sql=await readFile(file,"utf8");
      for(const statement of sql.split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(statement).run();
    }
    await run({mf,db,worker:await mf.getWorker()});
  } finally {await mf.dispose();}
}
async function seed(db,id="feed-a",due=overdue,hours=1){
  await db.prepare("INSERT INTO poc_sources (id,url,interval_hours,due_at) VALUES (?,?,?,?)")
    .bind(id,"https://example.com/"+id+".xml",hours,due).run();
}
const tick=(worker,ts=now)=>worker.scheduled({cron:CRON,scheduledTime:ts});
const count=db=>db.prepare("SELECT count(*) AS n FROM poc_news").first();

test("parallel Cron events cannot claim the same source twice",async()=>{
  let calls=0;
  await withWorker(async()=>{calls++;return new Response(rss(1))},async({db,worker})=>{
    await seed(db);
    const events=await Promise.all([tick(worker),tick(worker)]);
    assert(events.every(x=>x.outcome==="ok"));
    assert.equal(calls,1);
    assert.equal((await count(db)).n,1);
    const state=await db.prepare("SELECT lease_token,last_status FROM poc_sources WHERE id='feed-a'").first();
    assert.equal(state.last_status,"succeeded");
    assert.equal(state.lease_token,null);
  });
});
test("bounded serial batch leaves third due source for next tick; GET has no side effects",async()=>{
  const calls=[];
  await withWorker(async req=>{calls.push(new URL(req.url).pathname);return new Response(rss(1))},async({mf,db,worker})=>{
    for(const id of ["feed-a","feed-b","feed-c"]) await seed(db,id);
    assert.equal((await tick(worker)).outcome,"ok");
    assert.deepEqual(calls,["/feed-a.xml","/feed-b.xml"]);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM poc_sources WHERE last_status='succeeded'").first()).n,2);
    assert.equal((await mf.dispatchFetch("https://example.com/health")).status,200);
    assert.equal(calls.length,2);
    assert.equal((await tick(worker,now+300_000)).outcome,"ok");
    assert.deepEqual(calls,["/feed-a.xml","/feed-b.xml","/feed-c.xml"]);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM poc_sources WHERE last_status='succeeded'").first()).n,3);
  });
});
test("upstream failure backs off while other source progresses; successful retry resets failure counter",async()=>{
  let failures=0;
  await withWorker(async req=>{
    if(new URL(req.url).pathname==="/feed-a.xml" && failures++===0)return new Response("offline",{status:503});
    return new Response(rss(1));
  },async({db,worker})=>{
    await seed(db,"feed-a"); await seed(db,"feed-b");
    assert.equal((await tick(worker)).outcome,"ok");
    let row=await db.prepare("SELECT retry_count,last_status,last_error,due_at FROM poc_sources WHERE id='feed-a'").first();
    assert.equal(row.retry_count,1);
    assert.equal(row.last_status,"failed");
    assert.equal(row.last_error,"feed_http_503");
    assert(Date.parse(row.due_at)>now+300_000);
    assert(Date.parse(row.due_at)<now+345_000);
    assert.equal((await db.prepare("SELECT last_status FROM poc_sources WHERE id='feed-b'").first()).last_status,"succeeded");
    await tick(worker,now+60_000); // neither is due
    assert.equal((await db.prepare("SELECT retry_count FROM poc_sources WHERE id='feed-a'").first()).retry_count,1);
    // Making a source due is a D1 change; synthetic scheduledTime must not advance time.
    await db.prepare("UPDATE poc_sources SET due_at=? WHERE id=?").bind(overdue,"feed-a").run();
    assert.equal((await tick(worker,now+400_000)).outcome,"ok");
    row=await db.prepare("SELECT retry_count,last_status FROM poc_sources WHERE id='feed-a'").first();
    assert.equal(row.retry_count,0);
    assert.equal(row.last_status,"succeeded");
  });
});
test("expired lease can be reclaimed; stale holder may neither change source state nor insert news",async()=>{
  let entered;
  const arrived=new Promise(resolve=>entered=resolve);
  let release;
  const slow=new Promise(resolve=>release=resolve);
  let calls=0;
  await withWorker(async()=>{
    calls++;
    if(calls===1){entered();await slow;return new Response(rss(1).replace("story/0?lang=en","story/stale"));}
    return new Response(rss(1).replace("story/0?lang=en","story/current"));
  },async({db,worker})=>{
    await seed(db);
    const first=tick(worker);
    await arrived;
    // Simulate lease expiry in real D1; advancing scheduledTime is not a clock.
    await db.prepare("UPDATE poc_sources SET lease_expires_at=? WHERE id=?").bind(overdue,"feed-a").run();
    const newer=await tick(worker,now+61_000);
    assert.equal(newer.outcome,"ok");
    release();
    assert.equal((await first).outcome,"ok");
    assert.equal(calls,2);
    const urls=await db.prepare("SELECT url FROM poc_news").all();
    assert.deepEqual(urls.results.map(x=>x.url),["https://example.com/story/current"]);
    const source=await db.prepare("SELECT last_status,lease_token FROM poc_sources WHERE id='feed-a'").first();
    assert.equal(source.last_status,"succeeded");
    assert.equal(source.lease_token,null);
  });
});
test("D1 commit failure is not misclassified as feed HTTP failure; transaction rolls back",async()=>{
  await withWorker(async()=>new Response(rss(2)),async({db,worker})=>{
    await seed(db);
    await db.prepare("CREATE TRIGGER prevent_commit BEFORE UPDATE ON poc_sources WHEN NEW.last_status = 'succeeded' BEGIN SELECT RAISE(FAIL, 'injected persistence fault'); END").run();
    let failed=false;
    try {const result=await tick(worker);failed=result.outcome!=="ok";}catch{failed=true;}
    assert.equal(failed,true);
    assert.equal((await count(db)).n,0,"news inserts must roll back with failed completion");
    let row=await db.prepare("SELECT last_status,lease_token,retry_count FROM poc_sources WHERE id='feed-a'").first();
    assert.equal(row.last_status,null);
    assert.notEqual(row.lease_token,null,"original claim persists until timeout");
    assert.equal(row.retry_count,0);
    await db.prepare("DROP TRIGGER prevent_commit").run();
    // A crashed worker is reclaimed when its actual lease expires.
    await db.prepare("UPDATE poc_sources SET lease_expires_at=? WHERE id=?").bind(overdue,"feed-a").run();
    const outcome=await tick(worker,now+61_000);
    assert.equal(outcome.outcome,"ok");
    assert.equal((await count(db)).n,2);
    row=await db.prepare("SELECT last_status,lease_token FROM poc_sources WHERE id='feed-a'").first();
    assert.equal(row.last_status,"succeeded");
    assert.equal(row.lease_token,null);
  });
});
test("oversized feed and malformed response fail safely, preserving next eligible source",async()=>{
  await withWorker(async req=>{
    if(req.url.includes("feed-a"))return new Response("too large",{headers:{"content-length":"190000"}});
    if(req.url.includes("feed-b"))return new Response("<html>not a feed</html>");
    return new Response(rss(1));
  },async({db,worker})=>{
    for(const id of ["feed-a","feed-b","feed-c"])await seed(db,id);
    assert.equal((await tick(worker)).outcome,"ok");
    assert.equal((await count(db)).n,0);
    const states=await db.prepare("SELECT id,last_status,last_error FROM poc_sources ORDER BY id").all();
    assert.deepEqual(states.results.map(r=>r.last_status),["failed","failed",null]);
    assert.equal(states.results[0].last_error,"feed_too_large");
    assert.equal(states.results[1].last_error,"fetch_or_parse_error");
    assert.equal((await tick(worker,now+300_000)).outcome,"ok");
    assert.equal((await db.prepare("SELECT last_status FROM poc_sources WHERE id='feed-c'").first()).last_status,"succeeded");
  });
});

test("source interval remains hourly configurable regardless of five-minute wake",async()=>{
  let calls=0;
  await withWorker(async()=>{calls++;return new Response(rss(1));},async({db,worker})=>{
    await seed(db,"feed-a",overdue,3);
    assert.equal((await tick(worker)).outcome,"ok");
    const first=await db.prepare("SELECT due_at FROM poc_sources WHERE id='feed-a'").first();
    assert(Date.parse(first.due_at)>=now+3*3_600_000);
    assert(Date.parse(first.due_at)<Date.now()+3*3_600_000+3_000);
    assert.equal((await tick(worker,now+2*3_600_000)).outcome,"ok");
    assert.equal(calls,1,"Cron does not override the configured source interval");
    // Even a future scheduledTime cannot make a not-yet-due source eligible.
    assert.equal((await tick(worker,now+3*3_600_000+2_000)).outcome,"ok");
    assert.equal(calls,1);
    await db.prepare("UPDATE poc_sources SET due_at=? WHERE id=?").bind(overdue,"feed-a").run();
    assert.equal((await tick(worker)).outcome,"ok");
    assert.equal(calls,2);
    assert.equal((await count(db)).n,1,"same news URL remains idempotent");
  });
});

test("late-delivered Cron uses real execution time for leases and cannot be double-claimed",async()=>{
  let entered;
  const started=new Promise(resolve=>entered=resolve);
  let release;
  const held=new Promise(resolve=>release=resolve);
  let calls=0;
  await withWorker(async()=>{
    calls++;
    entered();
    await held;
    return new Response(rss(1));
  },async({db,worker})=>{
    await seed(db);
    const scheduledYesterday=Date.now()-24*3_600_000;
    const first=tick(worker,scheduledYesterday);
    try{
      await started;
      const record=await db.prepare("SELECT lease_expires_at FROM poc_sources WHERE id='feed-a'").first();
      assert(Date.parse(record.lease_expires_at)>=Date.now()+55_000,
        "Lease expiration must be based on actual start, not yesterday's scheduled event");
      const concurrent=await tick(worker,Date.now());
      assert.equal(concurrent.outcome,"ok");
      assert.equal(calls,1,"Second Cron must not re-fetch a source held by a delayed Cron");
    }finally{
      release();
      await first;
    }
    const source=await db.prepare("SELECT last_status,due_at FROM poc_sources WHERE id='feed-a'").first();
    assert.equal(source.last_status,"succeeded");
    assert(Date.parse(source.due_at)>Date.now()+3_590_000,
      "Success refresh interval must start at actual completion, not scheduled event time");
  });
});

test("late-delivered failed Cron schedules retry from actual failure time",async()=>{
  await withWorker(async()=>new Response("upstream unavailable",{status:503}),async({db,worker})=>{
    await seed(db);
    const before=Date.now();
    const result=await tick(worker,before-24*3_600_000);
    assert.equal(result.outcome,"ok");
    const row=await db.prepare("SELECT last_status,retry_count,due_at,lease_token FROM poc_sources WHERE id='feed-a'").first();
    assert.equal(row.last_status,"failed");
    assert.equal(row.retry_count,1);
    assert.equal(row.lease_token,null);
    assert(Date.parse(row.due_at)>=before+300_000,
      "Retry cannot be anchored to yesterday's scheduled event time");
    assert(Date.parse(row.due_at)<Date.now()+345_000,
      "First failure must remain inside the bounded retry window");
  });
});
