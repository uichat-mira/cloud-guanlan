import { createApp, type GuanlanEnv } from "../src/app";
import { createFixtureVerifier } from "../src/mcp/auth";
import { createMcpRuntime } from "../src/mcp/runtime";
import { CLOUD_AUTH_TOKEN_ISSUER } from "../src/mcp/config";
import { FIXTURE_TOKENS } from "./mcp-fixtures";

const app = createApp({
  resolveMcpRuntime: env => createMcpRuntime(env, {
    verifier: createFixtureVerifier(FIXTURE_TOKENS, {
      issuer: CLOUD_AUTH_TOKEN_ISSUER,
      audience: env.MCP_AUDIENCE ?? "",
    }),
  }),
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, _env: GuanlanEnv, _ctx: ExecutionContext) {
    // The fixture worker exists only for MCP HTTP contract tests.
  },
};
