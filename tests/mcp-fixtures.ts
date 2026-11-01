import type { GuanlanPrincipal } from "../src/mcp/auth";

export const MCP_TEST_RESOURCE_URL = "https://127.0.0.1/mcp";
export const MCP_TEST_ISSUER = "https://auth.example.com"; // OAuth authorization-server URL
export const MCP_TEST_TOKEN_ISSUER = "mira:cloud-auth"; // Signed Cloud Auth credential issuer
export const MCP_TEST_JWKS_URL = "https://auth.example.com/.well-known/jwks.json";
export const MCP_TEST_AUDIENCE = "mira:cloud-guanlan";
export const MCP_TEST_SCOPE = "guanlan.read";
export const MCP_TEST_WRITE_SCOPE = "guanlan.write";
export const MCP_TEST_FUTURE_EXP = 4_102_444_800; // 2100-01-01T00:00:00Z

const base = (): GuanlanPrincipal => ({
  accountId: "account-a",
  consumerId: "consumer-1",
  scopes: [MCP_TEST_SCOPE],
  expiresAt: MCP_TEST_FUTURE_EXP,
  issuer: MCP_TEST_TOKEN_ISSUER,
  audience: MCP_TEST_AUDIENCE,
});

/** Read + the independent write scope; never a superset of account authority. */
const readWrite = (): GuanlanPrincipal => ({ ...base(), scopes: [MCP_TEST_SCOPE, MCP_TEST_WRITE_SCOPE] });

export const FIXTURE_TOKENS: Record<string, GuanlanPrincipal> = {
  "fixture-consumer-1": base(),
  "fixture-consumer-2": { ...base(), consumerId: "consumer-2" },
  "fixture-account-b": { ...base(), accountId: "account-b", consumerId: "consumer-b" },
  // Verified credentials whose Guanlan space is deliberately not provisioned.
  "fixture-unprovisioned": { ...base(), accountId: "account-z", consumerId: "consumer-z" },
  "fixture-empty-account": { ...base(), accountId: "account-empty", consumerId: "consumer-empty" },
  // Read + guanlan.write: the only fixtures allowed to change consumption state.
  "fixture-writer-1": readWrite(),
  "fixture-writer-2": { ...readWrite(), consumerId: "consumer-2" },
  "fixture-writer-account-b": { ...readWrite(), accountId: "account-b", consumerId: "consumer-b" },
  "fixture-writer-unprovisioned": { ...readWrite(), accountId: "account-z", consumerId: "consumer-z" },
  "fixture-writer-empty": { ...readWrite(), accountId: "account-empty", consumerId: "consumer-empty" },
  "fixture-wrong-issuer": { ...base(), issuer: "https://relay.example.com" },
  "fixture-shiyan-audience": { ...base(), audience: "https://api.shiyan.example.com" },
  "fixture-relay-audience": { ...base(), audience: "https://api.relay.example.com" },
  "fixture-wrong-scope": { ...base(), scopes: ["news.write"] },
  "fixture-expired": { ...base(), expiresAt: 1 },
  "fixture-missing-consumer": { ...base(), consumerId: "" },
};
