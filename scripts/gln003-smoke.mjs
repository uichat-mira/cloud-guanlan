#!/usr/bin/env node
// GLN-003 read-only public HTTP smoke: no D1 writes, no deployment, no secrets.
const url = process.env.GLN003_CANARY_URL;
if (!url) throw new Error("GLN003_CANARY_URL is required");
const root = new URL(url);
if (root.protocol !== "https:" || root.username || root.password ||
    !root.hostname.startsWith("cloud-guanlan-gln003-canary.")) {
  throw new Error("The URL must be the isolated GLN-003 Worker HTTPS hostname");
}
const endpoint=path=>new URL(path,root);
const health=await fetch(endpoint("/health"),{signal:AbortSignal.timeout(10_000)});
if (health.status!==200) throw new Error("canary health returned HTTP "+health.status);
const json=await health.json();
if (json.service!=="cloud-guanlan-poc" || json.publicApi!==false || json.status!=="ok")
  throw new Error("unexpected health contract");
for(const path of ["/articles","/api/news","/sources","/account"]){
  const response=await fetch(endpoint(path),{signal:AbortSignal.timeout(10_000)});
  if(response.status!==404) throw new Error("unexpected public route at "+path+" ("+response.status+")");
}
console.log(JSON.stringify({service:"cloud-guanlan-gln003-canary",health:"ok",privateRoutes:"404",checkedAt:new Date().toISOString()}));
