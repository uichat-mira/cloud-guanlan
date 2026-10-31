import { test } from "node:test";
import assert from "node:assert/strict";
import {retryDelayMs,nextSuccessAt,nextFailureAt,MAX_SOURCES_PER_INVOCATION,CRON_EXPRESSION} from "../dist/scheduler.mjs";

const now=Date.parse("2026-11-01T00:00:00Z");
test("success schedules exact hourly increments",()=>{
  assert.equal(nextSuccessAt(now,1),"2026-11-01T01:00:00.000Z");
  assert.equal(nextSuccessAt(now,24),"2026-11-02T00:00:00.000Z");
  assert.throws(()=>nextSuccessAt(now,0));
  assert.throws(()=>nextSuccessAt(now,25));
});
test("retries back off, are bounded and stable for a given source",()=>{
  const times=[0,1,2,3,10].map(n=>retryDelayMs(n,"feed-a"));
  assert(times.every((ms,i)=>i===0||ms>=times[i-1]));
  assert(times[0]>=300_000&&times[0]<345_000);
  assert(times[4] <= 6*3_600_000+45_000);
  assert.equal(retryDelayMs(17,"feed-a"),retryDelayMs(16,"feed-a"));
  assert.equal(nextFailureAt(now,2,"feed-a"),new Date(now+times[2]).toISOString());
});
test("fixed Cron wake frequency is independent of configured feed interval",()=>{
  assert.equal(CRON_EXPRESSION,"*/5 * * * *");
  assert.equal(MAX_SOURCES_PER_INVOCATION,2);
});
