import {
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  type OAuthMetadata,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/server";

export const MCP_RESOURCE_PATH = "/mcp";
export const MCP_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
export const GUANLAN_REQUIRED_SCOPE = "guanlan.read";
/**
 * Independent write authority for `guanlan_news_decide`. It is intentionally
 * not part of `requiredScopes`: the global `/mcp` bearer gate must keep
 * accepting read-only credentials, and the write tool checks this scope itself.
 * The name is the planned Cloud Auth scope; formal issuance is owned by the
 * Cloud Auth contract and is not claimed here.
 */
export const GUANLAN_WRITE_SCOPE = "guanlan.write";
/** True only for a credential that carries the explicit Guanlan write scope. */
export const hasWriteScope = (scopes: readonly string[]): boolean =>
  scopes.includes(GUANLAN_WRITE_SCOPE);
/** Cloud Auth service credentials have a deployment-neutral JWT issuer. */
export const CLOUD_AUTH_TOKEN_ISSUER = "mira:cloud-auth";
export const GUANLAN_SERVICE_AUDIENCE = "mira:cloud-guanlan";
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
  /** OAuth authorization-server URL advertised in RFC 9728 discovery. */
  issuer: string;
  /** JWT issuer of Cloud Auth credentials, distinct from its OAuth URL. */
  tokenIssuer: string;
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
 * OAuth authorization-server/JWKS bindings are explicit; the JWT issuer is
 * the canonical deployment-neutral Cloud Auth identity. Missing or malformed
 * configuration leaves /mcp unconfigured rather than open.
 */
export function resolveMcpConfig(env: McpEnv): McpConfigResult {
  const resourceUrl = secureUrl(env.MCP_RESOURCE_URL?.trim() ?? "");
  if (!resourceUrl) return { ok: false, reason: "mcp_resource_url" };
  if (resourceUrl.pathname !== MCP_RESOURCE_PATH) return { ok: false, reason: "mcp_resource_path" };

  // This URL is for OAuth discovery, never for JWT `iss` comparison.
  const issuer = env.CLOUD_AUTH_ISSUER?.trim() ?? "";
  if (!secureUrl(issuer)) return { ok: false, reason: "cloud_auth_issuer" };

  const jwksUrl = secureUrl(env.CLOUD_AUTH_JWKS_URL?.trim() ?? "");
  if (!jwksUrl) return { ok: false, reason: "cloud_auth_jwks_url" };

  const audience = env.MCP_AUDIENCE?.trim() ?? "";
  if (!audience) return { ok: false, reason: "mcp_audience" };
  // Current Cloud Auth service credentials use a named Guanlan audience.
  // Resource-URI audiences are also supported for the separate future OAuth flow.
  // Never allow a Shiyan/Relay/other service audience through configuration.
  if (audience !== GUANLAN_SERVICE_AUDIENCE &&
      withoutTrailingSlash(audience) !== withoutTrailingSlash(resourceUrl.href)) {
    return { ok: false, reason: "mcp_audience_not_guanlan" };
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
      tokenIssuer: CLOUD_AUTH_TOKEN_ISSUER,
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
    serviceDocumentationUrl: new URL("https://github.com/uichat-mira/cloud-mcp-guanlan"),
  });
  return {
    ...metadata,
    bearer_methods_supported: ["header"],
  };
}
