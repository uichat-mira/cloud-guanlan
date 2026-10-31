#!/usr/bin/env node
// GLN-003: read-only Cloudflare Analytics SQL API. No deploys or D1 mutations.
const account=process.env.GLN003_ACCOUNT_ID;
const database=process.env.GLN003_DATABASE_ID;
const token=process.env.CLOUDFLARE_API_TOKEN;
const from=process.env.GLN003_FROM;
const to=process.env.GLN003_TO;
const script="cloud-guanlan-gln003-canary";
if(!/^[0-9a-f]{32}$/i.test(account??"") ||
   !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(database??"") ||
   !token || !from || !to) {
  throw new Error("Requires GLN003_ACCOUNT_ID, GLN003_DATABASE_ID, CLOUDFLARE_API_TOKEN, GLN003_FROM, GLN003_TO");
}
const start=new Date(from),end=new Date(to);
if(!Number.isFinite(+start)||!Number.isFinite(+end)||start>=end||end-start>24*3_600_000)
  throw new Error("Metrics window must be positive and at most 24 hours");

async function query(sql){
  const res=await fetch("https://api.cloudflare.com/client/v4/accounts/"+account+"/analytics/sql",{
    method:"POST",
    headers:{"authorization":"Bearer "+token,"content-type":"application/json"},
    body:JSON.stringify({
      query:sql,
      scope:{accountTag:account},
      time_range:{start:start.toISOString(),end:end.toISOString()}
    }),
    signal:AbortSignal.timeout(20_000)
  });
  if(!res.ok)throw new Error("Analytics SQL HTTP "+res.status+"; verify Account Analytics Read");
  const body=await res.json();
  if(!Array.isArray(body.data))throw new Error("Analytics SQL response missing data array");
  return body.data;
}
const logs=await query(`SELECT timestamp,invocationType,cpuTimeMs,wallTimeMs,httpStatus,error
FROM logs.workersLogs WHERE scriptName='${script}' ORDER BY timestamp DESC LIMIT 200`);
const rows=await query(`SELECT timestamp,rowsRead,rowsWritten,queryDurationMs,error
FROM events.d1Queries WHERE databaseId='${database}' ORDER BY timestamp DESC LIMIT 1000`);
const summarize=(items)=>items.length?{
  count:items.length,
  cpuMs:{min:Math.min(...items.map(x=>x.cpuTimeMs)),max:Math.max(...items.map(x=>x.cpuTimeMs)),
    sum:items.reduce((n,x)=>n+x.cpuTimeMs,0)},
  wallTimeMs:{min:Math.min(...items.map(x=>x.wallTimeMs)),max:Math.max(...items.map(x=>x.wallTimeMs))},
}:null;
const invocations=logs.filter(x=>x.invocationType==="scheduled" && x.wallTimeMs>0);
const http=logs.filter(x=>x.invocationType==="fetch" && x.wallTimeMs>0);
const output={
  source:"Cloudflare Analytics SQL API (live account data)",
  script,window:{from:start.toISOString(),to:end.toISOString()},
  scheduled:summarize(invocations),
  http:summarize(http),
  d1:rows.length?{
    observedQueries:rows.length,
    rowsRead:rows.reduce((n,x)=>n+(x.rowsRead??0),0),
    rowsWritten:rows.reduce((n,x)=>n+(x.rowsWritten??0),0),
    queryDurationMs:rows.reduce((n,x)=>n+(x.queryDurationMs??0),0),
    errors:rows.filter(x=>x.error).length
  }:null,
  caveats:[
    "Analytics datasets may be sampled and delayed. An empty series means no observed sample, not zero use.",
    "Workers Logs includes custom log lines; wallTimeMs>0 filters out zero-duration log messages to approximate invocations.",
    "D1 data includes manual setup and verification queries in the time range; do not attribute all rows to the Cron.",
    "A Free-tier suitability decision requires scheduled success/real RSS parsing and adequate sample windows, not HTTP health CPU alone."
  ]
};
// Emit exactly one JSON line: never interpolate upstream text into log formatting.\nprocess.stdout.write(JSON.stringify(output)+"\\n");
