import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const run=(args,extraEnv={})=>spawnSync(process.execPath,["scripts/gln003-config.mjs",...args],{
  env:{...process.env,GLN003_ACCOUNT_ID:"",GLN003_DATABASE_ID:"",GLN003_CONFIRMED_PLAN:"",GLN003_CONFIRM_ISOLATION:"",GLN003_CONFIRM_CRON:"",...extraEnv},
  encoding:"utf8",
});
test("no account or confirmed Free plan never generates an operational config",()=>{
  const noArgs=run([]);
  assert.notEqual(noArgs.status,0);
  assert.match(noArgs.stderr,/ACCOUNT_ID/);
  const planUnknown=run([],{
    GLN003_ACCOUNT_ID:"11111111111111111111111111111111",
    GLN003_DATABASE_ID:"11111111-2222-3333-4444-555555555555",
    GLN003_CONFIRM_ISOLATION:"cloud-guanlan-gln003-canary",
  });
  assert.notEqual(planUnknown.status,0);
  assert.match(planUnknown.stderr,/Free plan/);
});
test("real plan attestation is not sufficient without independent isolation acknowledgement",()=>{
  const r=run([],{
    GLN003_ACCOUNT_ID:"11111111111111111111111111111111",
    GLN003_DATABASE_ID:"11111111-2222-3333-4444-555555555555",
    GLN003_CONFIRMED_PLAN:"free",
  });
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/isolation/);
});
test("isolated canary has Cron disabled until separately acknowledged",async()=>{
  const base={
    GLN003_ACCOUNT_ID:"11111111111111111111111111111111",
    GLN003_DATABASE_ID:"11111111-2222-3333-4444-555555555555",
    GLN003_CONFIRMED_PLAN:"free",
    GLN003_CONFIRM_ISOLATION:"cloud-guanlan-gln003-canary",
  };
  const staged=run([],base);
  assert.equal(staged.status,0,staged.stderr);
  const config=JSON.parse(await readFile("dist/gln003/wrangler.json","utf8"));
  assert.equal(config.main,"../../src/index.ts");
  assert.equal(config.name,"cloud-guanlan-gln003-canary");
  assert.equal(config.workers_dev,true);
  assert.deepEqual(config.routes,[]);
  assert.deepEqual(config.triggers.crons,[]);
  assert.equal(config.d1_databases[0].database_name,config.name);
  const denied=run(["--enable-cron"],base);
  assert.notEqual(denied.status,0);
  assert.match(denied.stderr,/Cron activation/);
  const enabled=run(["--enable-cron"],{...base,GLN003_CONFIRM_CRON:"yes"});
  assert.equal(enabled.status,0,enabled.stderr);
  const c=JSON.parse(await readFile("dist/gln003/wrangler.json","utf8"));
  assert.deepEqual(c.triggers.crons,["*/5 * * * *"]);
  // Return to safe configuration after tests.
  assert.equal(run(["--dry-run"]).status,0);
});
test("dry-run uses only an impossible remote DB placeholder and never enables Cron",async()=>{
  const r=run(["--dry-run"]);
  assert.equal(r.status,0,r.stderr);
  const c=JSON.parse(await readFile("dist/gln003/wrangler.json","utf8"));
  assert.equal(c.d1_databases[0].database_id,"00000000-0000-0000-0000-000000000000");
  assert.deepEqual(c.triggers.crons,[]);
  assert(!Object.hasOwn(c,"account_id"));
  assert(!r.stdout.includes("11111111111111111111111111111111"));
});

test("HTTP smoke refuses non-Cloudflare host without contacting it",()=>{
  for(const url of [
    "https://cloud-guanlan-gln003-canary.example.com",
    "https://cloud-guanlan-gln003-canary.foo.workers.dev.evil.test",
    "http://cloud-guanlan-gln003-canary.test.workers.dev",
  ]){
    const result=spawnSync(process.execPath,["scripts/gln003-smoke.mjs"],{
      env:{...process.env,GLN003_CANARY_URL:url},encoding:"utf8",timeout:5000
    });
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/isolated GLN-003 Worker HTTPS hostname/);
  }
});
