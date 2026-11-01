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
  GUANLAN_WRITE_SCOPE,
  buildMcpProtectedResourceMetadata,
  hasWriteScope,
  type McpConfig,
} from "./config";
import {
  DECIDE_INPUT_SCHEMA,
  DECIDE_OUTPUT_SCHEMA,
  DECIDE_TOOL_DESCRIPTION,
  DECIDE_TOOL_ERRORS,
  DECIDE_TOOL_NAME,
  NEWS_INPUT_SCHEMA,
  NEWS_OUTPUT_SCHEMA,
  NEWS_TOOL_DESCRIPTION,
  NEWS_TOOL_ERRORS,
  NEWS_TOOL_NAME,
  READ_ONLY_ANNOTATIONS,
  WHOAMI_OUTPUT_SCHEMA,
  WHOAMI_TOOL_DESCRIPTION,
  WHOAMI_TOOL_NAME,
  WRITE_ANNOTATIONS,
  renderDecisionMarkdown,
  renderNewsMarkdown,
  type DecisionResult,
} from "./capabilities";
import {
  NewsReadError,
  type GuanlanNewsDecider,
  type GuanlanNewsReader,
  type NewsDecisionOutcome,
} from "./service";

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

/**
 * Maps a domain decision failure to an explicit tool error. Conflicts carry the
 * bounded current decision (never a fingerprint or another subject's data) so a
 * client can re-read and retry truthfully; an unknown article and an
 * unauthorized source share one opaque `not_available` answer.
 */
function decisionErrorText(outcome: Extract<NewsDecisionOutcome, { ok: false }>): string {
  const currentText = (current: {
    url: string;
    status: string;
    version: number;
    reason: string | null;
    outcomeUrl: string | null;
    decidedAt: string | null;
  }): string => JSON.stringify({
    url: current.url,
    status: current.status,
    version: current.version,
    reason: current.reason,
    outcomeUrl: current.outcomeUrl,
    decidedAt: current.decidedAt,
  });
  switch (outcome.failure) {
    case "version_conflict":
      return `${DECIDE_TOOL_ERRORS.versionConflict}: expectedVersion did not match the stored decision; current state ${currentText(outcome.current)}. Re-read the article before deciding again.`;
    case "operation_conflict":
      return `${DECIDE_TOOL_ERRORS.operationConflict}: this operationId was already applied with different decision content; current state ${currentText(outcome.current)}. Use a new operationId for a new decision.`;
    case "not_available":
      return `${DECIDE_TOOL_ERRORS.notAvailable}: the article is not available for a decision under this verified identity.`;
    case "principal_unavailable":
      return `${DECIDE_TOOL_ERRORS.principalUnavailable}: the verified identity has no provisioned Cloud Guanlan space; retry after provisioning.`;
    case "invalid_request":
      return `${DECIDE_TOOL_ERRORS.invalidRequest}: the decision is outside the supported bounds (canonical http(s) URL, bounded reason/outcome link, no surrounding whitespace).`;
  }
}

function decisionResultOf(outcome: Extract<NewsDecisionOutcome, { ok: true }>): DecisionResult {
  return {
    result: outcome.result,
    state: {
      url: outcome.state.url,
      status: outcome.state.status,
      version: outcome.state.version,
      sourceId: outcome.state.sourceId,
      reason: outcome.state.reason,
      outcomeUrl: outcome.state.outcomeUrl,
      decidedAt: outcome.state.decidedAt,
    },
  };
}

function buildMcpServer(
  authInfo: AuthInfo | undefined,
  reader: GuanlanNewsReader,
  decider: GuanlanNewsDecider,
): McpServer {
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

  server.registerTool(
    DECIDE_TOOL_NAME,
    {
      title: "Decide a Cloud Guanlan news item",
      description: DECIDE_TOOL_DESCRIPTION,
      inputSchema: DECIDE_INPUT_SCHEMA,
      outputSchema: DECIDE_OUTPUT_SCHEMA,
      annotations: WRITE_ANNOTATIONS,
    },
    async (args) => {
      // Independent write authority. The bearer gate already proved the read
      // scope; a read-only credential must still never reach the ledger.
      if (!hasWriteScope(principal.scopes)) {
        return {
          content: [{
            type: "text",
            text: `${DECIDE_TOOL_ERRORS.forbidden}: this credential does not carry the ${GUANLAN_WRITE_SCOPE} scope; read access never grants state changes.`,
          }],
          isError: true,
        };
      }
      try {
        const outcome = await decider.decide(principal, {
          url: args.url,
          status: args.status,
          expectedVersion: args.expectedVersion,
          operationId: args.operationId,
          reason: args.reason,
          outcomeUrl: args.outcomeUrl,
        });
        if (outcome.ok) {
          const structured = decisionResultOf(outcome);
          return {
            content: [{ type: "text", text: renderDecisionMarkdown(structured) }],
            structuredContent: structured,
          };
        }
        return {
          content: [{ type: "text", text: decisionErrorText(outcome) }],
          isError: true,
        };
      } catch {
        // A ledger/D1 failure is an explicit storage error, never a conflict,
        // a denial or an implied success.
        return {
          content: [{
            type: "text",
            text: `${DECIDE_TOOL_ERRORS.unavailable}: the decision ledger could not be written; retry later.`,
          }],
          isError: true,
        };
      }
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
  decider: GuanlanNewsDecider,
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
    ({ authInfo }) => buildMcpServer(authInfo, reader, decider),
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
