import { createCloudAuthVerifier, type GuanlanTokenVerifier } from "./auth";
import { resolveMcpConfig, type McpEnv } from "./config";
import { createGuanlanMcp, type GuanlanMcpRuntime } from "./server";
import { createD1NewsReader, type GuanlanNewsReader } from "./service";

export type McpRuntimeEnv = McpEnv & { DB: D1Database };

export type McpRuntimeOptions = {
  /** Test-only injection; the deployed entry never supplies this. */
  verifier?: GuanlanTokenVerifier;
  reader?: GuanlanNewsReader;
};

export type McpRuntimeResult =
  | { ok: true; runtime: GuanlanMcpRuntime }
  | { ok: false; reason: string };

const cache = new WeakMap<D1Database, Map<string, McpRuntimeResult>>();

/**
 * Resolves config and dependencies for one request. Production trust is built
 * only from the configured Cloud Auth issuer/JWKS/audience; tests inject a
 * deterministic verifier through their own worker entry, not through env.
 */
export function createMcpRuntime(env: McpRuntimeEnv, options: McpRuntimeOptions = {}): McpRuntimeResult {
  const resolved = resolveMcpConfig(env);
  if (!resolved.ok) return resolved;

  const { config } = resolved;
  if (options.verifier || options.reader) {
    const verifier = options.verifier ?? createCloudAuthVerifier({
      issuer: config.issuer,
      audience: config.audience,
      jwksUrl: config.jwksUrl,
      consumerClaim: config.consumerClaim,
    });
    const reader = options.reader ?? createD1NewsReader(env.DB);
    return { ok: true, runtime: createGuanlanMcp(config, verifier, reader) };
  }

  const key = [
    config.resourceUrl.href,
    config.issuer,
    config.jwksUrl.href,
    config.audience,
    config.requiredScopes.join(" "),
    config.consumerClaim,
  ].join("\n");
  let byKey = cache.get(env.DB);
  if (!byKey) {
    byKey = new Map();
    cache.set(env.DB, byKey);
  }
  const existing = byKey.get(key);
  if (existing) return existing;

  const verifier = createCloudAuthVerifier({
    issuer: config.issuer,
    audience: config.audience,
    jwksUrl: config.jwksUrl,
    consumerClaim: config.consumerClaim,
  });
  const result: McpRuntimeResult = {
    ok: true,
    runtime: createGuanlanMcp(config, verifier, createD1NewsReader(env.DB)),
  };
  byKey.set(key, result);
  return result;
}
