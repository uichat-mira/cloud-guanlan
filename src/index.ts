import { createApp, type GuanlanEnv } from "./app";
import { collectDue } from "./ingest";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: GuanlanEnv, _ctx: ExecutionContext) {
    const outcome = await collectDue(env, event.scheduledTime);
    console.log(JSON.stringify({ event: "poc_collect", ...outcome }));
    if (outcome.errors > 0) console.error("Guanlan scheduled collection: one or more sources failed (details in D1).");
  },
};
