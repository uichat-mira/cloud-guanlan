import { Hono } from "hono";
import { collectDue, type PocEnv } from "./ingest";

const app = new Hono<{ Bindings: PocEnv }>();
app.get("/health", c => c.json({ service: "cloud-guanlan-poc", status: "ok", publicApi: false }));
// Deliberately no public news read/write endpoints until Cloud Auth and scopes exist.
app.notFound(c => c.json({error:"not_found"},404));

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: PocEnv, _ctx: ExecutionContext) {
    const outcome = await collectDue(env,event.scheduledTime);
    console.log(JSON.stringify({event:"poc_collect", ...outcome}));
    if (outcome.errors > 0) console.error("GLN-001 source refresh failed; inspect D1 poc_sources.last_error");
  },
};
