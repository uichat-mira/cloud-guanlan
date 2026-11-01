import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { rss } from "./fixtures.mjs";

const TEST_ID="00000000-0000-4000-8000-000000000001";
// GLN-008: the collector only fetches maintainer-approved public feeds, so the
// T3 fixture uses a real approved source URL instead of an arbitrary host.
const APPROVED_FEED="https://developers.cloudflare.com/changelog/rss/index.xml";
async function withWorker(fetcher, run){
 const mf=new Miniflare({
   modules:true, scriptPath:"dist/worker.mjs",compatibilityDate:"2026-08-06",cf:false,
   d1Databases:{DB:TEST_ID},
   serviceBindings:{TEST_FEED_FETCHER:async(request)=>fetcher(request)}
 });
 try{
   const db=await mf.getD1Database("DB");
   // D1 exec() processes each line separately on this runtime. Apply the same
   // real DDL statements individually; Wrangler still owns migration sequencing.
   for (const path of ["migrations/0001_poc.sql","migrations/0002_source_leases.sql"]) {
     const sql = await readFile(path,"utf8");
     for(const statement of sql.split(";").map(s=>s.trim()).filter(Boolean)){
       await db.prepare(statement).run();
     }
   }
   await run({mf,db});
 }finally{await mf.dispose();}
}
async function seed(db,url=APPROVED_FEED,id="feed1"){
 await db.prepare("INSERT INTO poc_sources (id,url,interval_hours,due_at) VALUES (?,?,?,?)")
   .bind(id,url,1,"2026-10-31T00:00:00.000Z").run();
}
const now=Date.parse("2026-10-31T01:00:00.000Z");
test("real workerd scheduled handler writes into local D1 and is repeatable",async()=>{
 let requests=0;
 await withWorker(async req=>{requests++;assert.equal(req.url,APPROVED_FEED);return new Response(rss(3),{headers:{"content-type":"application/rss+xml"}})},async({mf,db})=>{
   await seed(db);
   const worker=await mf.getWorker();
   const response=await mf.dispatchFetch("https://example.com/health");
   assert.equal(response.status,200);
   assert.equal((await response.json()).publicApi,false);
   assert.equal((await mf.dispatchFetch("https://example.com/articles")).status,404);
   assert.equal((await db.prepare("SELECT count(*) AS n FROM poc_news").first()).n,0);
   const outcome=await worker.scheduled({cron:"*/5 * * * *",scheduledTime:now});
   assert.equal(outcome.outcome,"ok");
   const firstSource = await db.prepare("SELECT last_status, last_error FROM poc_sources WHERE id='feed1'").first();
   assert.equal(firstSource.last_status,"succeeded", JSON.stringify(firstSource));
   assert.equal((await db.prepare("SELECT count(*) AS n FROM poc_news").first()).n,3);
   assert.equal((await db.prepare("SELECT last_status FROM poc_sources WHERE id='feed1'").first()).last_status,"succeeded");
   // A read must not implicitly refresh or write any data.
   await mf.dispatchFetch("https://example.com/health");
   assert.equal(requests,1);
   await worker.scheduled({cron:"*/5 * * * *",scheduledTime:now});
   assert.equal(requests,1); // not due; no duplicate fetch
   assert.equal((await db.prepare("SELECT count(*) AS n FROM poc_news").first()).n,3);
   // Do not fake clock advancement with scheduledTime: mark source due in D1.
   await db.prepare("UPDATE poc_sources SET due_at=? WHERE id=?").bind(new Date(Date.now()-1_000).toISOString(),"feed1").run();
   await worker.scheduled({cron:"*/5 * * * *",scheduledTime:now+3601_000});
   assert.equal(requests,2);
   assert.equal((await db.prepare("SELECT count(*) AS n FROM poc_news").first()).n,3); // URL dedup
 });
});
test("HTTP error is preserved on source without destroying saved news",async()=>{
 let attempts=0;
 await withWorker(async()=>{
  attempts++;return attempts===1?new Response(rss(1)):new Response("upstream down",{status:503});
 },async({mf,db})=>{
  await seed(db);
  const worker=await mf.getWorker();
  await worker.scheduled({cron:"*/5 * * * *",scheduledTime:now});
  await db.prepare("UPDATE poc_sources SET due_at=? WHERE id=?").bind(new Date(Date.now()-1_000).toISOString(),"feed1").run();
  await worker.scheduled({cron:"*/5 * * * *",scheduledTime:now+3601_000});
  const row=await db.prepare("SELECT last_status,last_error FROM poc_sources WHERE id='feed1'").first();
  assert.equal(row.last_status,"failed");
  assert.match(row.last_error,/503/);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM poc_news").first()).n,1);
 });
});
test("oversized feed is rejected; no partial write",async()=>{
 await withWorker(async()=>new Response(rss(1),{headers:{"content-length":"200000"}}),async({mf,db})=>{
  await seed(db);
  await (await mf.getWorker()).scheduled({cron:"*/5 * * * *",scheduledTime:now});
  assert.match((await db.prepare("SELECT last_error FROM poc_sources WHERE id='feed1'").first()).last_error,/feed_too_large/);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM poc_news").first()).n,0);
 });
});
