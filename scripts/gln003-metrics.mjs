#!/usr/bin/env node
// Reads real Cloudflare GraphQL analytics. Does not deploy or mutate resources.
const account=process.env.GLN003_ACCOUNT_ID;
const database=process.env.GLN003_DATABASE_ID;
const token=process.env.CLOUDFLARE_API_TOKEN;
const from=process.env.GLN003_FROM;
const to=process.env.GLN003_TO;
if(!/^[0-9a-f]{32}$/i.test(account??"") ||
   !/^[0-9a-f-]{36}$/i.test(database??"") ||
   !token || !from || !to) {
  throw new Error("Requires GLN003_ACCOUNT_ID, GLN003_DATABASE_ID, CLOUDFLARE_API_TOKEN, GLN003_FROM, GLN003_TO");
}
const start=new Date(from),end=new Date(to);
if(!Number.isFinite(+start)||!Number.isFinite(+end)||start>=end || end-start>24*3_600_000)
  throw new Error("Metrics window must be valid, positive and no longer than 24 hours");
const query=`query GLN003Metrics($accountTag: string!, $scriptName: string!,
  $start: Time!, $end: Time!, $startDate: Date!, $endDate: Date!, $databaseId: string!) {
  viewer { accounts(filter:{accountTag:$accountTag}) {
    workersInvocationsAdaptive(limit:1,
      filter:{scriptName:$scriptName,datetime_geq:$start,datetime_leq:$end}) {
      sum { requests errors }
      quantiles { cpuTimeP50 cpuTimeP99 }
    }
    d1AnalyticsAdaptiveGroups(limit:32,
      filter:{databaseId:$databaseId,date_geq:$startDate,date_leq:$endDate}) {
      sum { readQueries writeQueries }
      dimensions { date databaseId }
    }
  }}
}`;
const res=await fetch("https://api.cloudflare.com/client/v4/graphql",{
  method:"POST",
  headers:{"authorization":"Bearer "+token,"content-type":"application/json"},
  body:JSON.stringify({query,variables:{
    accountTag:account,databaseId:database,scriptName:"cloud-guanlan-gln003-canary",
    start:start.toISOString(),end:end.toISOString(),
    startDate:start.toISOString().slice(0,10),endDate:end.toISOString().slice(0,10),
  }}),
  signal:AbortSignal.timeout(15_000),
});
if(!res.ok)throw new Error("GraphQL HTTP "+res.status+"; confirm Account Analytics Read scope");
const body=await res.json();
if(body.errors?.length || !body.data?.viewer?.accounts?.length)
  throw new Error("GraphQL query was not accepted; verify Analytics Read scope and supported dataset schema");
const data=body.data.viewer.accounts[0];
const worker=data.workersInvocationsAdaptive??[];
const d1=data.d1AnalyticsAdaptiveGroups??[];
const output={
  source:"Cloudflare GraphQL Analytics API",
  script:"cloud-guanlan-gln003-canary",window:{from:start.toISOString(),to:end.toISOString()},
  worker:worker[0]??null,
  d1:d1.map(x=>({date:x.dimensions?.date,queries:x.sum})),
  caveats:[
    "D1 readQueries/writeQueries are query counts, NOT rows read/written",
    "D1 daily aggregation can include activity outside this interval; inspect per-query meta and Dashboard Row Metrics",
    "Worker CPU values represent reported quantiles; no live-account measurements exist until this script is executed successfully",
  ],
};
console.log(JSON.stringify(output,null,2));
