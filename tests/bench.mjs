import { Miniflare } from "miniflare";
const mf=new Miniflare({modules:true,scriptPath:"dist/bench.mjs",compatibilityDate:"2026-10-01",cf:false});
try{
 for(const count of [5,40]){
   const r=await mf.dispatchFetch("https://example.com/bench?count="+count);
   if(!r.ok)throw Error("benchmark worker failed "+r.status);
   const o=await r.json();
   if(o.observations.some(x=>x.items!==count))throw Error("parser item mismatch");
   console.log(JSON.stringify(o));
 }
}finally{await mf.dispose();}
