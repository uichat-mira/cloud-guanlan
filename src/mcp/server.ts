import {
  createMcpHandler,
  hostHeaderValidationResponse,
  McpServer,
  originValidationResponse,
  requireBearerAuth,
  type AuthInfo,
  type OAuthProtectedResourceMetadata,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import {
  authInfoFromPrincipal,
  principalFromAuthInfo,
  type GuanlanTokenVerifier,
} from "./auth";
import {
  GUANLAN_MCP_SERVER_NAME,
  GUANLAN_MCP_SERVER_VERSION,
  buildMcpProtectedResourceMetadata,
  type McpConfig,
} from "./config";
import {
  NEWS_INPUT_SCHEMA,
  NEWS_LIMIT_DEFAULT,
  NEWS_OUTPUT_SCHEMA,
  NEWS_TOOL_DESCRIPTION,
  NEWS_TOOL_ERRORS,
  NEWS_TOOL_NAME,
  READ_ONLY_ANNOTATIONS,
  WHOAMI_OUTPUT_SCHEMA,
  WHOAMI_TOOL_DESCRIPTION,
  WHOAMI_TOOL_NAME,
  renderNewsMarkdown,
  type NewsPage,
} from "./capabilities";
import type { GuanlanNewsReader } from "./service";

const MAX_REQUEST_BODY_BYTES = 256 * 1024;

function buildMcpServer(authInfo: AuthInfo | undefined, reader: GuanlanNewsReader): McpServer {
  const principal = principalFromAuthInfo(authInfo);
  const server = new McpServer(
    { name: GUANLAN_MCP_SERVER_NAME, version: GUANLAN_MCP_SERVER_VERSION },
    { capabilities: { tools: {} }, maxToolInputElements: 100 },
  );

  server.registerTool(
    NEWS_TOOL_NAME,
    {
      title: "Recent Cloud Guanlan news",
      description: NEWS_TOOL_DESCRIPTION,
      inputSchema: NEWS_INPUT_SCHEMA,
      outputSchema: NEWS_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit }) => {
      const requested = limit ?? NEWS_LIMIT_DEFAULT;
      try {
        const items = await reader.listRecent(principal, { limit: requested });
        const page: NewsPage = { items, count: items.length, limit: requested };
        return {
          content: [{ type: "text", text: renderNewsMarkdown(page) }],
          structuredContent: page,
        };
      } catch {
        // A failed read is an explicit tool error, never a plausible empty page.
        return {
          content: [{
            type: "text",
            text: `${NEWS_TOOL_ERRORS.unavailable}: the news index could not be read; retry later.`,
          }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    WHOAMI_TOOL_NAME,
    {
      title: "Cloud Guanlan caller identity",
      description: WHOAMI_TOOL_DESCRIPTION,
      outputSchema: WHOAMI_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const identity = {
        accountId: principal.accountId,
        consumerId: principal.consumerId,
        scopes: [...principal.scopes],
      };
      return {
        content: [{ type: "text", text: JSON.stringify(identity) }],
        structuredContent: identity,
      };
    },
  );

  return server;
}

export type GuanlanMcpRuntime = {
  metadata: OAuthProtectedResourceMetadata;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
};

const metadataResponse = (
  request: Request,
  metadata: OAuthProtectedResourceMetadata,
): Response => {
  if (request.method === "OPTIONS") {
    const requested = request.headers.get("access-control-request-headers");
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        ...(requested ? { "Access-Control-Allow-Headers": requested } : {}),
      },
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ error: "method_not_allowed" }, {
      status: 405,
      headers: { Allow: "GET, HEAD, OPTIONS", "Access-Control-Allow-Origin": "*" },
    });
  }
  const body = request.method === "HEAD" ? null : JSON.stringify(metadata);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
};

/**
 * Builds the isolated Streamable HTTP /mcp surface. The SDK handler owns MCP
 * protocol semantics; this wrapper owns Host/Origin validation, bearer
 * verification, protected-resource discovery and the fail-closed path routing.
 */
export function createGuanlanMcp(
  config: McpConfig,
  verifier: GuanlanTokenVerifier,
  reader: GuanlanNewsReader,
): GuanlanMcpRuntime {
  const tokenVerifier: OAuthTokenVerifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      return authInfoFromPrincipal(token, await verifier.verifyAccessToken(token));
    },
  };
  const gate = requireBearerAuth({
    verifier: tokenVerifier,
    requiredScopes: config.requiredScopes,
    expectedResource: config.resourceUrl,
    resourceMetadataUrl: config.metadataUrl,
  });
  const handler = createMcpHandler(
    ({ authInfo }) => buildMcpServer(authInfo, reader),
    { legacy: "stateless", maxRequestBodySize: MAX_REQUEST_BODY_BYTES },
  );
  const metadata = buildMcpProtectedResourceMetadata(config);
  const metadataPath = new URL(config.metadataUrl).pathname;

  return {
    metadata,
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path !== metadataPath && path !== config.resourceUrl.pathname) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }

      const rejected =
        hostHeaderValidationResponse(request, [config.resourceUrl.hostname]) ??
        originValidationResponse(request, [config.resourceUrl.hostname]);
      if (rejected) return rejected;

      if (path === metadataPath) return metadataResponse(request, metadata);

      const auth = await gate(request);
      if (auth instanceof Response) return auth;
      return handler.fetch(request, { authInfo: auth });
    },
    close: () => handler.close(),
  };
}
