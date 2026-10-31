# GLN-004 · Remote MCP protocol entry and Cloud Auth boundary

> [Work item #8](https://github.com/uichat-mira/cloud-guanlan/issues/8).
> **Status: implemented on a feature branch for review; not deployed.** No production
> Worker, Cron, D1 migration, Cloud Auth issuance, Desktop/Mobile client or real-user
> end-to-end authorization is claimed here.

## 1. What this slice delivers

- One isolated Streamable HTTP endpoint at `POST/GET/DELETE /mcp` inside the existing
  Hono Worker. No second Worker and no alternate REST agent API.
- MCP protocol revision **`2026-07-28`** for modern requests:
  - per-request version/client metadata envelope;
  - required `MCP-Protocol-Version`, `Mcp-Method` and (for named calls) `Mcp-Name`
    headers;
  - no `Mcp-Session-Id` and no long-lived protocol session;
  - `server/discover` and genuine MCP `tools/list` / `tools/call`.
- Stateless legacy compatibility for **`2025-06-18` / `2025-11-25` `initialize`
  clients** from the same tool factory. Legacy `GET`/`DELETE` session operations are
  intentionally unavailable (`405`) because no session is created.
- RFC 9728 protected-resource metadata at
  `GET /.well-known/oauth-protected-resource/mcp`, and a 401
  `WWW-Authenticate: Bearer ... resource_metadata="..."` challenge.
- A narrow resource-server verifier contract. Guanlan verifies tokens; it never issues
  them.
- A small read-only tool surface with one typed schema/error source of truth.

## 2. Exact runtime and SDK versions

| Component | Version |
| --- | --- |
| Protocol revision served | `2026-07-28` modern, `2025-06-18`/`2025-11-25` legacy |
| `@modelcontextprotocol/server` | `2.4.0` |
| `@modelcontextprotocol/client` (test-only) | `2.4.0` |
| `jose` | `6.2.14` |
| `zod` | `4.6.7` |
| `hono` | `4.13.14` |
| Runtime compatibility date | `2026-08-06` (unchanged) |

The server entry is `createMcpHandler(factory, { legacy: 'stateless' })`; the client
tests use real `Client` + `StreamableHTTPClientTransport` instances, not hand-rolled
`tools/list` fakes.

## 3. Configuration and fail-closed behavior

The deployed Worker stays **closed** unless all of these bindings resolve:

| Binding | Meaning |
| --- | --- |
| `MCP_RESOURCE_URL` | Canonical public resource URL; path must be exactly `/mcp` |
| `CLOUD_AUTH_ISSUER` | HTTPS OAuth authorization-server URL advertised in protected-resource discovery (not the JWT `iss`) |
| `CLOUD_AUTH_JWKS_URL` | Cloud Auth public JWKS URL for access-token verification |
| `MCP_AUDIENCE` | Exact Guanlan JWT audience: current Cloud Auth-shaped service value `mira:cloud-guanlan`, or the canonical `/mcp` resource URL for future RFC 8707 resource-URI tokens |
| `MCP_REQUIRED_SCOPES` | Optional, default `guanlan.read`; space-separated OAuth scope tokens |
| `MCP_CONSUMER_CLAIM` | Optional, default `consumer_id`; stable consumer claim in the token |

- Missing or malformed configuration makes `/mcp` and its metadata return
  `503 {"error":"mcp_not_configured"}`. There is no anonymous or fixture fallback.
- URLs must be HTTPS (localhost HTTP is allowed only for local testing).
- The JWT signing issuer is the **deployment-neutral `mira:cloud-auth`**, separate from the OAuth authorization-server URL. The deployed JWT verifier allows only Cloud Auth Ed25519/`EdDSA` signatures.
- `MCP_AUDIENCE` accepts only the dedicated service audience `mira:cloud-guanlan` or the exact `/mcp` resource URL. Existing Shiyan/Relay audiences are rejected. The SDK `expectedResource` remains the canonical `/mcp` URL regardless of the JWT audience representation.
- No secret is committed. JWKS is public key material; no Cloud Auth private key,
  client secret or device session is stored in this repository.

### Verifier contract

`createCloudAuthVerifier` uses Cloud Auth's JWKS and requires:

- exact JWT `iss = mira:cloud-auth`; protected-resource metadata separately advertises the configured HTTPS `CLOUD_AUTH_ISSUER` URL;
- `aud` matching `MCP_AUDIENCE` / the Guanlan resource URL;
- a numeric, unexpired `exp`;
- a non-empty `sub` (Cloud Account identity);
- a non-empty `consumer_id` claim (or the configured claim name);
- the required scope after the SDK bearer gate: Cloud Auth-shaped `scope: string[]` and standard space-delimited OAuth `scope: string` are recognized; malformed scope arrays are rejected;
- an EdDSA signature verified against the configured Cloud Auth Ed25519 JWKS.

A failed verification is an opaque `401 invalid_token`; a valid token lacking the
required scope is `403 insufficient_scope`. The verifier does **not** use a
model-supplied name, URL parameter or tool argument as consumer identity.

## 4. Tool surface

Single source of truth: [`src/mcp/capabilities.ts`](../../src/mcp/capabilities.ts).

| Tool | Input | Output | Annotation |
| --- | --- | --- | --- |
| `guanlan_news_recent` | bounded `limit` `1..50` (default 20) | bounded `items`, `count`, `limit` | `readOnlyHint: true`, no destructive/idempotent side effects |
| `guanlan_whoami` | none | token-derived `accountId`, `consumerId`, `scopes` | `readOnlyHint: true` |

- Both tools are registered from the same typed capability definitions used by
  `tools/list` and `tools/call`.
- `guanlan_news_recent` reads the existing GLN-003 `poc_news` index with a `SELECT` only.
  It does not fetch feeds, claim leases, update source rows or write consumer state.
- Output strings are bounded (title 500, summary 2 000, URL 4 096, source id 200),
  request bodies are capped at 256 KiB, and tool argument elements are capped.
- Full canonical URLs remain the unchanged stable `id` and `url` in returned data; URLs exceeding the output bound are **rejected as a tool error** rather than truncated or collapsed. No per-item hashing is introduced into the Free Worker read path.
- A D1/read failure or oversized URL returns `isError: true` with `guanlan_news_unavailable`; it does not return an empty `items` array as if there were no news.
- The current shared POC index has no per-user subscription rows yet. This tool is an
  authenticated read of the shared public-source index, not the future personalized
  subscription API. Per-user filtering arrives with the source/subscription work.

## 5. Legacy and client compatibility

- Modern clients must opt into `2026-07-28` (`versionNegotiation` in the SDK); the SDK
  default remains the 2025 `initialize` handshake.
- The server accepts legacy `2025-06-18` / `2025-11-25` initialize clients through the
  SDK's stateless fallback. No `Mcp-Session-Id` is issued on either path.
- The Wrangler deployment is still not authorized by this document. `dev` is not
  production, and no Cloudflare route or Cron change is part of this slice.

## 6. Follow-up dependencies (not delivered)

1. **Cloud Auth** must issue Guanlan-specific audience/scope credentials and expose the
   standard authorization-server discovery/client registration flow for MCP OAuth.
2. **Desktop** must add modern `2026-07-28` transport and OAuth support; its current
   `2025-06-18` handshake and manual Bearer are not proof of modern support.
3. **Mobile** must choose direct MCP or a Host `ToolGatewayClient` bridge. Neither path
   exists yet.
4. Real-user end-to-end acceptance is blocked until items 1–3 are separately
   implemented and verified.

## 7. Verification evidence

Run from the repository root:

```bash
bash scripts/check.sh
```

The gate includes:

- `npm run typecheck`;
- T1 auth/protocol/schema tests in `tests/mcp-auth.test.mjs`;
- real workerd/Miniflare + D1 MCP tests in `tests/mcp-workerd.test.mjs`, covering:
  modern pinned client discover/list/call, both 2025 legacy clients, no session id,
  protocol-header rejection, 401/403 negatives, protected-resource metadata,
  read-only no-write proof, D1 failure mapping, and the closed default Worker;
- signed Ed25519/EdDSA Cloud Auth-shaped JWT fixture with separate JWT issuer/OAuth URL, dedicated audience, `scope: string[]`, valid/invalid consumer, wrong-scope and wrong-audience cases;
- long URLs with identical first 2,048 characters retain distinct exact IDs and links; oversized source URLs fail explicitly;
- the existing GLN-001..003 parser, scheduler, Cron, lease, canary and Wrangler
  dry-run gates.

Local results and any CI run belong to the PR/Issue evidence, not this document.
**No real Cloud Auth token, Cloudflare deployment or Desktop/Mobile connection has been
verified in this slice.**
