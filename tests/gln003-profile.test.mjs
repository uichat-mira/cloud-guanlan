import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Miniflare} from "miniflare";
import {rss} from "./fixtures.mjs";

const SOURCE="gln003-cf-status";
const URL="https://www.cloudflarestatus.com/history.atom";
const D1_UUID="00000000-0000-4000-8000-000000000033";

test("real scheduled three-mode profiler uses bounded production fetch, parser and D1",async()=>{
  let networkCalls=0;
  const mf=new Miniflare({
    modules:true,scriptPath:"dist/gln003-profile.mjs",compatibilityDate:"2026-08-06",cf:false,
    d1Databases:{DB:D1_UUID},
    serviceBindings:{TEST_FEED_FETCHER:async(req)=>{
      assert.equal(req.url,URL);
      networkCalls++;
      return new Response(rss(25));
    }}
  });
  try{
    const db=await mf.getD1Database("DB");
    for(const path of ["migrations/0001_poc.sql","migrations/0002_source_leases.sql"]){
      const ddl=await readFile(path,"utf8");
      for(const query of ddl.split(";").map(x=>x.trim()).filter(Boolean))await db.prepare(query).run();
    }
    await db.prepare("CREATE TABLE gln003_profile_plan(id TEXT PRIMARY KEY,run INTEGER NOT NULL DEFAULT 0)").run();
    await db.prepare(`CREATE TABLE gln003_profile_samples(
      run INTEGER PRIMARY KEY,mode TEXT NOT NULL,success INTEGER NOT NULL,
      articles INTEGER NOT NULL,inserted INTEGER NOT NULL,wall_ms INTEGER NOT NULL,
      error_code TEXT NOT NULL)`).run();
    await db.prepare("INSERT INTO gln003_profile_plan(id,run) VALUES (?,0)").bind("gln003-profile-v1").run();
    await db.prepare("INSERT INTO poc_sources(id,url,interval_hours,due_at) VALUES (?,?,?,?)")
      .bind(SOURCE,URL,1,"1970-01-01T00:00:00.000Z").run();
    const health=await mf.dispatchFetch("https://example.test/health");
    assert.equal(health.status,200);
    assert.equal((await health.json()).publicApi,false);
    assert.equal((await mf.dispatchFetch("https://example.test/articles")).status,404);

    const worker=await mf.getWorker();
    for(let i=1;i<=9;i++){
      const event=await worker.scheduled({cron:"* * * * *",scheduledTime:Date.now()});
      assert.equal(event.outcome,"ok");
      assert.equal(networkCalls,i);
      const done=await db.prepare("SELECT run,mode,success,inserted,error_code FROM gln003_profile_samples WHERE run=?").bind(i).first();
      assert.equal(done?.run,i);
      assert.equal(done.mode,["fetch","parse","full"][(i-1)%3]);
      assert.equal(done.success,1,JSON.stringify(done));
      assert.equal(done.error_code,"");
      const news=await db.prepare("SELECT count(*) AS n FROM poc_news").first();
      if(i<3)assert.equal(news.n,0,"no D1 article writes in fetch/parse-only mode");
      else assert.equal(news.n,25,"full mode writes once; subsequent runs dedupe URLs");
      if(i===3)assert.equal(done.inserted,25);
      if(i>3 && done.mode==="full")assert.equal(done.inserted,0);
    }
    const tenth=await worker.scheduled({cron:"* * * * *",scheduledTime:Date.now()});
    assert.equal(tenth.outcome,"ok");
    assert.equal(networkCalls,9,"hard cap must stop all network after nine test runs");
    const plan=await db.prepare("SELECT run FROM gln003_profile_plan WHERE id=?").bind("gln003-profile-v1").first();
    assert.equal(plan.run,9);
    const state=await db.prepare("SELECT last_status,lease_token,retry_count FROM poc_sources WHERE id=?").bind(SOURCE).first();
    assert.deepEqual(state,{last_status:"succeeded",lease_token:null,retry_count:0});
  }finally{await mf.dispose();}
});
