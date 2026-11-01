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
  NEWS_OUTPUT_SCHEMA,
  NEWS_TOOL_DESCRIPTION,
  NEWS_TOOL_ERRORS,
  NEWS_TOOL_NAME,
  READ_ONLY_ANNOTATIONS,
  WHOAMI_OUTPUT_SCHEMA,
  WHOAMI_TOOL_DESCRIPTION,
  WHOAMI_TOOL_NAME,
  renderNewsMarkdown,
} from "./capabilities";
import { NewsReadError, type GuanlanNewsReader } from "./service";

const MAX_REQUEST_BODY_BYTES = 256 * 1024;

/**
 * Maps a domain failure to an opaque, actionable tool error. Messages never
 * distinguish "another account/consumer exists" from "it does not", and a
 * failed read is never rendered as an empty page.
 */
function newsToolErrorText(error: unknown): string {
  const unavailable = `${NEWS_TOOL_ERRORS.unavailable}: the news index could not be read; retry later.`;
  if (!(error instanceof NewsReadError)) return unavailable;
  switch (error.code) {
    case "invalid_cursor":
      return `${NEWS_TOOL_ERRORS.cursorInvalid}: the cursor is malformed, belongs to another identity or filter set, or was modified; retry without a cursor.`;
    case "invalid_subject":
    case "principal_unavailable":
      return `${NEWS_TOOL_ERRORS.principalUnavailable}: the verified identity has no provisioned Cloud Guanlan space; retry after provisioning.`;
    case "invalid_query":
      return `${NEWS_TOOL_ERRORS.queryInvalid}: the query is outside the supported bounds.`;
    default:
      return unavailable;
  }
}

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
    async (args) => {
      try {
        const page = await reader.listPage(principal, {
          limit: args.limit,
          cursor: args.cursor,
          sourceId: args.sourceId,
          status: args.status,
          keyword: args.keyword,
          ingestedAfter: args.ingestedAfter,
          ingestedBefore: args.ingestedBefore,
          publishedAfter: args.publishedAfter,
          publishedBefore: args.publishedBefore,
        });
        return {
          content: [{ type: "text", text: renderNewsMarkdown(page) }],
          structuredContent: page,
        };
      } catch (error) {
        // A failed read is an explicit tool error, never a plausible empty page.
        return {
          content: [{ type: "text", text: newsToolErrorText(error) }],
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
      return authInfoFromPrincipal(token, await verifier.verifyAccessToken(token), config.resourceUrl);
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
