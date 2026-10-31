import { parseWithFeedsmith,parseWithFastXml } from "../src/parser";
const BASE = "https://example.com/rss.xml";
function rss(count:number):string{
 return '<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title><link>https://example.com</link><description>Fixture</description>'+
 Array.from({length:count},(_,i)=>'<item><title>Article '+i+'</title><link>https://example.com/'+i+'</link><description>Some metadata only</description><pubDate>Fri, 30 Oct 2026 00:00:00 GMT</pubDate></item>').join("")+'</channel></rss>';
}
export default {
 fetch(request:Request){
  const count = new URL(request.url).searchParams.get("count")==="40"?40:5;
  const document=rss(count);
  const observations=[];
  for(const [name,parser] of [["feedsmith",parseWithFeedsmith],["fast-xml-parser",parseWithFastXml]] as const){
   const times=[];
   let items=0;
   for(let i=0;i<12;i++){
    const before=performance.now();
    items=parser(document,BASE).length;
    times.push(performance.now()-before);
   }
   times.sort((a,b)=>a-b);
   observations.push({parser:name,items,medianMs:times[6],maxMs:times[11],samples:times.length});
  }
  return Response.json({fixtureItems:count,bytes:new TextEncoder().encode(document).length,observations,measurement:"workerd performance.now wall time (NOT Cloudflare billed CPU)"});
 }
};
