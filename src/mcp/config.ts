import {
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  type OAuthMetadata,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/server";

export const MCP_RESOURCE_PATH = "/mcp";
export const MCP_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
export const GUANLAN_REQUIRED_SCOPE = "guanlan.read";
export const GUANLAN_MCP_SERVER_NAME = "cloud-guanlan";
export const GUANLAN_MCP_SERVER_VERSION = "0.1.0-gln-004";

export type McpEnv = {
  MCP_RESOURCE_URL?: string;
  CLOUD_AUTH_ISSUER?: string;
  CLOUD_AUTH_JWKS_URL?: string;
  MCP_AUDIENCE?: string;
  MCP_REQUIRED_SCOPES?: string;
  MCP_CONSUMER_CLAIM?: string;
};

export type McpConfig = {
  resourceUrl: URL;
  metadataUrl: string;
  issuer: string;
  jwksUrl: URL;
  audience: string;
  requiredScopes: string[];
  consumerClaim: string;
};

export type McpConfigResult =
  | { ok: true; config: McpConfig }
  | { ok: false; reason: string };

const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const secureUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return null;
    if (url.protocol === "https:") return url;
    if (url.protocol === "http:" && localHostnames.has(url.hostname)) return url;
    return null;
  } catch {
    return null;
  }
};
const scopeToken = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const claimName = /^[A-Za-z0-9_.-]+$/;
const withoutTrailingSlash = (value: string) => value.endsWith("/") ? value.slice(0, -1) : value;

/**
 * Resolves the fail-closed resource-server boundary from deployment bindings.
 * No value is defaulted to a real Mira or third-party trust anchor: an absent
 * or malformed setting leaves the /mcp surface unconfigured rather than open.
 */
export function resolveMcpConfig(env: McpEnv): McpConfigResult {
  const resourceUrl = secureUrl(env.MCP_RESOURCE_URL?.trim() ?? "");
  if (!resourceUrl) return { ok: false, reason: "mcp_resource_url" };
  if (resourceUrl.pathname !== MCP_RESOURCE_PATH) return { ok: false, reason: "mcp_resource_path" };

  // Keep the configured issuer string byte-exact for JWT `iss` comparison and
  // metadata advertisement; URL normalisation could add a trailing slash that
  // Cloud Auth does not mint.
  const issuer = env.CLOUD_AUTH_ISSUER?.trim() ?? "";
  if (!secureUrl(issuer)) return { ok: false, reason: "cloud_auth_issuer" };

  const jwksUrl = secureUrl(env.CLOUD_AUTH_JWKS_URL?.trim() ?? "");
  if (!jwksUrl) return { ok: false, reason: "cloud_auth_jwks_url" };

  const audience = env.MCP_AUDIENCE?.trim() ?? "";
  if (!audience) return { ok: false, reason: "mcp_audience" };
  if (withoutTrailingSlash(audience) !== withoutTrailingSlash(resourceUrl.href)) {
    return { ok: false, reason: "mcp_audience_not_resource" };
  }

  const scopes = (env.MCP_REQUIRED_SCOPES?.trim() || GUANLAN_REQUIRED_SCOPE)
    .split(/\s+/)
    .filter(Boolean);
  if (!scopes.length || scopes.some(scope => !scopeToken.test(scope))) {
    return { ok: false, reason: "mcp_required_scopes" };
  }

  const consumerClaim = env.MCP_CONSUMER_CLAIM?.trim() || "consumer_id";
  if (!claimName.test(consumerClaim)) return { ok: false, reason: "mcp_consumer_claim" };

  return {
    ok: true,
    config: {
      resourceUrl,
      metadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
      issuer,
      jwksUrl,
      audience,
      requiredScopes: scopes,
      consumerClaim,
    },
  };
}

export function buildMcpProtectedResourceMetadata(config: McpConfig): OAuthProtectedResourceMetadata {
  const metadata = buildOAuthProtectedResourceMetadata({
    oauthMetadata: { issuer: config.issuer } as OAuthMetadata,
    resourceServerUrl: config.resourceUrl,
    scopesSupported: config.requiredScopes,
    resourceName: "Cloud Guanlan",
    serviceDocumentationUrl: new URL("https://github.com/uichat-mira/cloud-guanlan"),
  });
  return {
    ...metadata,
    bearer_methods_supported: ["header"],
  };
}
