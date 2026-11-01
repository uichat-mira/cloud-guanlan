import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  MCP_TEST_AUDIENCE,
  MCP_TEST_ISSUER,
  MCP_TEST_JWKS_URL,
  MCP_TEST_RESOURCE_URL,
  MCP_TEST_SCOPE,
} from "../dist/mcp-fixtures.mjs";

const TEST_ID = "00000000-0000-4000-8000-000000000008";
const FIXTURE_BINDINGS = {
  MCP_RESOURCE_URL: MCP_TEST_RESOURCE_URL,
  CLOUD_AUTH_ISSUER: MCP_TEST_ISSUER,
  CLOUD_AUTH_JWKS_URL: MCP_TEST_JWKS_URL,
  MCP_AUDIENCE: MCP_TEST_AUDIENCE,
  MCP_REQUIRED_SCOPES: MCP_TEST_SCOPE,
};

async function withWorker(scriptPath, bindings, run) {
  const mf = new Miniflare({
    modules: true,
    scriptPath,
    compatibilityDate: "2026-08-06",
    cf: false,
    d1Databases: { DB: TEST_ID },
    bindings,
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const path of [
      "migrations/0001_poc.sql",
      "migrations/0002_source_leases.sql",
      "migrations/0003_guanlan_accounts.sql",
      "migrations/0004_consumer_news_state.sql",
    ]) {
      const sql = await readFile(path, "utf8");
      for (const statement of sql.split(";").map(s => s.trim()).filter(Boolean)) {
        await db.prepare(statement).run();
      }
    }
    await run({ mf, db });
  } finally {
    await mf.dispose();
  }
}

async function seed(db) {
  await db.prepare("INSERT INTO poc_sources (id,url,interval_hours,due_at) VALUES (?,?,?,?)")
    .bind("feed-1", "https://example.com/rss.xml", 1, "2026-10-31T00:00:00.000Z").run();
  await db.prepare(`
    INSERT INTO poc_news (url,source_id,title,summary,published_at,ingested_at)
    VALUES (?,?,?,?,?,?)
  `).bind(
    "https://example.com/story",
    "feed-1",
    "Example story",
    "Example summary",
    "2026-10-31T00:00:00.000Z",
    "2026-10-31T00:01:00.000Z",
  ).run();
  // GLN-009: the news tool is authorized per account × consumer, so the MCP
  // fixture identity needs a provisioned space and one effective source.
  const createdAt = "2026-10-31T00:00:00.000Z";
  await db.prepare("INSERT INTO guanlan_accounts (account_id,created_at) VALUES (?,?)")
    .bind("account-a", createdAt).run();
  for (const consumerId of ["consumer-1", "consumer-2"]) {
    await db.prepare("INSERT INTO guanlan_consumers (account_id,consumer_id,created_at) VALUES (?,?,?)")
      .bind("account-a", consumerId, createdAt).run();
  }
  await db.prepare(`
    INSERT INTO guanlan_account_subscriptions (account_id,source_id,interval_hours,created_at)
    VALUES (?,?,?,?)
  `).bind("account-a", "feed-1", 1, createdAt).run();
}

function disconnectedFetch(mf) {
  return async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    return mf.dispatchFetch(url, init);
  };
}

async function connect(mf, token, options = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_TEST_RESOURCE_URL), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: disconnectedFetch(mf),
  });
  const client = new Client({ name: "gln004-test", version: "1.0.0" }, options);
  await client.connect(transport);
  return { client, transport };
}

test("real workerd modern MCP client discovers and calls read-only tools", async () => {
  await withWorker("dist/mcp-test-worker.mjs", FIXTURE_BINDINGS, async ({ mf, db }) => {
    await seed(db);
    const { client, transport } = await connect(mf, "fixture-consumer-1", {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    });
    try {
      assert.equal(client.getProtocolEra(), "modern");
      assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
      assert.equal(transport.sessionId, undefined);

      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map(tool => tool.name).sort(),
        ["guanlan_news_decide", "guanlan_news_recent", "guanlan_whoami"],
      );
      for (const tool of listed.tools) {
        const readOnly = tool.name !== "guanlan_news_decide";
        assert.equal(tool.annotations?.readOnlyHint, readOnly, tool.name);
        assert.equal(tool.annotations?.destructiveHint, false);
      }

      const news = await client.callTool({
        name: "guanlan_news_recent",
        arguments: { limit: 10 },
      });
      assert.equal(news.isError, undefined);
      assert.equal(news.structuredContent.count, 1);
      assert.equal(news.structuredContent.items[0].title, "Example story");
      // GLN-010: the read page carries the CAS token for a decision write.
      assert.equal(news.structuredContent.items[0].stateVersion, 0);

      const invalid = await client.callTool({
        name: "guanlan_news_recent",
        arguments: { limit: 51 },
      });
      assert.equal(invalid.isError, true);
      assert.match(invalid.content[0].text, /Input validation error/);

      const whoami = await client.callTool({ name: "guanlan_whoami", arguments: {} });
      assert.equal(whoami.structuredContent.consumerId, "consumer-1");
      assert.equal(whoami.structuredContent.accountId, "account-a");
      assert.deepEqual(whoami.structuredContent.scopes, [MCP_TEST_SCOPE]);

      // A model-supplied consumer name cannot override the token-derived identity.
      const spoofed = await client.callTool({
        name: "guanlan_whoami",
        arguments: { consumerId: "consumer-2", accountId: "account-b" },
      });
      assert.equal(spoofed.structuredContent.consumerId, "consumer-1");
      assert.equal(spoofed.structuredContent.accountId, "account-a");
    } finally {
      await client.close();
    }
  });
});

test("real workerd 2025-06-18 and 2025-11-25 initialize clients use the documented stateless legacy path", async () => {
  await withWorker("dist/mcp-test-worker.mjs", FIXTURE_BINDINGS, async ({ mf, db }) => {
    await seed(db);
    for (const version of ["2025-06-18", "2025-11-25"]) {
      const { client, transport } = await connect(mf, "fixture-consumer-2", {
        supportedProtocolVersions: [version],
      });
      try {
        assert.equal(client.getProtocolEra(), "legacy");
        assert.equal(client.getNegotiatedProtocolVersion(), version);
        assert.equal(transport.sessionId, undefined);
        const listed = await client.listTools();
        assert.equal(listed.tools.length, 3);
        const news = await client.callTool({
          name: "guanlan_news_recent",
          arguments: { limit: 5 },
        });
        assert.equal(news.isError, undefined);
        assert.equal(news.structuredContent.items.length, 1);
        assert.match(news.content[0].text, /Example story/);
      } finally {
        await client.close();
      }
    }
  });
});

test("modern requests carry no session id and reject missing standard headers", async () => {
  await withWorker("dist/mcp-test-worker.mjs", FIXTURE_BINDINGS, async ({ mf }) => {
    const envelope = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "raw-test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    };
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer fixture-consumer-1",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list",
    };
    const ok = await mf.dispatchFetch(MCP_TEST_RESOURCE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("mcp-session-id"), null);
    assert.equal((await ok.json()).result.tools.length, 3);

    const missingHeaders = { ...headers };
    delete missingHeaders["Mcp-Method"];
    const missing = await mf.dispatchFetch(MCP_TEST_RESOURCE_URL, {
      method: "POST",
      headers: missingHeaders,
      body: JSON.stringify(envelope),
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, -32020);
  });
});

test("unauthorized callers see 401 discovery but no tools or data", async () => {
  await withWorker("dist/mcp-test-worker.mjs", FIXTURE_BINDINGS, async ({ mf, db }) => {
    await seed(db);
    const unauthorized = await mf.dispatchFetch(MCP_TEST_RESOURCE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(unauthorized.status, 401);
    assert.match(
      unauthorized.headers.get("www-authenticate"),
      /resource_metadata="https:\/\/127\.0\.0\.1\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
    const body = await unauthorized.text();
    assert.doesNotMatch(body, /guanlan_news_recent|Example story/);

    const metadata = await mf.dispatchFetch(
      "https://127.0.0.1/.well-known/oauth-protected-resource/mcp",
    );
    assert.equal(metadata.status, 200);
    const document = await metadata.json();
    assert.equal(document.resource, MCP_TEST_RESOURCE_URL);
    assert.deepEqual(document.authorization_servers, [MCP_TEST_ISSUER]);
    assert.deepEqual(document.scopes_supported, [MCP_TEST_SCOPE]);

    for (const [token, status] of [
      ["fixture-wrong-issuer", 401],
      ["fixture-shiyan-audience", 401],
      ["fixture-relay-audience", 401],
      ["fixture-expired", 401],
      ["fixture-missing-consumer", 401],
      ["fixture-wrong-scope", 403],
    ]) {
      const rejected = await mf.dispatchFetch(MCP_TEST_RESOURCE_URL, {
        method: "GET",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
      });
      assert.equal(rejected.status, status, token);
    }
  });
});

test("read-only calls do not mutate the GLN-003 source, lease or news rows", async () => {
  await withWorker("dist/mcp-test-worker.mjs", FIXTURE_BINDINGS, async ({ mf, db }) => {
    await seed(db);
    const before = {
      news: await db.prepare("SELECT count(*) AS n FROM poc_news").first(),
      source: await db.prepare("SELECT due_at,last_checked_at,lease_token,lease_expires_at FROM poc_sources WHERE id='feed-1'").first(),
    };
    const { client } = await connect(mf, "fixture-consumer-1", {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    });
    try {
      await client.callTool({ name: "guanlan_news_recent", arguments: { limit: 50 } });
      await client.callTool({ name: "guanlan_whoami", arguments: {} });
    } finally {
      await client.close();
    }
    assert.deepEqual(await db.prepare("SELECT count(*) AS n FROM poc_news").first(), before.news);
    assert.deepEqual(
      await db.prepare("SELECT due_at,last_checked_at,lease_token,lease_expires_at FROM poc_sources WHERE id='feed-1'").first(),
      before.source,
    );
  });
});

test("a database read failure is an explicit tool error, not empty-news success", async () => {
  await withWorker("dist/mcp-test-worker.mjs", FIXTURE_BINDINGS, async ({ mf, db }) => {
    await seed(db);
    const { client } = await connect(mf, "fixture-consumer-1", {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    });
    try {
      await db.prepare("DROP TABLE poc_news").run();
      const result = await client.callTool({ name: "guanlan_news_recent", arguments: {} });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.match(result.content[0].text, /guanlan_news_unavailable/);
      assert.doesNotMatch(result.content[0].text, /No news items/);
    } finally {
      await client.close();
    }
  });
});

test("long article URLs preserve distinct stable identities and exact fetchable links", async () => {
  await withWorker("dist/mcp-test-worker.mjs", FIXTURE_BINDINGS, async ({ mf, db }) => {
    await seed(db);
    const prefix = "https://example.com/story?" + "a".repeat(2100);
    const urls = [prefix + "-first", prefix + "-second"];
    for (let i = 0; i < urls.length; i++) {
      await db.prepare("INSERT INTO poc_news (url,source_id,title,summary,published_at,ingested_at) VALUES (?,?,?,?,?,?)")
        .bind(urls[i], "feed-1", "Long URL " + i, "", null, "2026-11-01T00:00:00.000Z").run();
    }
    const { client } = await connect(mf, "fixture-consumer-1", {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    });
    try {
      const read = () => client.callTool({ name: "guanlan_news_recent", arguments: { limit: 10 } });
      const response = await read();
      assert.equal(response.isError, undefined);
      const selected = response.structuredContent.items.filter(item => urls.includes(item.url));
      assert.equal(selected.length, 2);
      assert.deepEqual(new Set(selected.map(item => item.url)), new Set(urls));
      assert.notEqual(selected[0].id, selected[1].id);
      for (const item of selected) {
        assert.equal(item.id, item.url);
        assert.ok(item.url.length > 2048);
      }
      const again = await read();
      assert.deepEqual(
        again.structuredContent.items.filter(item => urls.includes(item.url)).map(item => item.id),
        selected.map(item => item.id),
      );

      // A row beyond the output bound fails explicitly; no truncated link.
      await db.prepare("INSERT INTO poc_news (url,source_id,title,summary,published_at,ingested_at) VALUES (?,?,?,?,?,?)")
        .bind("https://example.com/" + "z".repeat(5000), "feed-1", "Overlong link", "", null, "2026-11-02T00:00:00.000Z").run();
      const overlong = await read();
      assert.equal(overlong.isError, true);
      assert.match(overlong.content[0].text, /guanlan_news_unavailable/);
      assert.equal(overlong.structuredContent, undefined);
    } finally {
      await client.close();
    }
  });
});

test("the deployed default worker has no MCP fixture fallback and stays closed", async () => {
  await withWorker("dist/worker.mjs", {}, async ({ mf, db }) => {
    await seed(db);
    assert.equal((await mf.dispatchFetch("https://example.com/health")).status, 200);
    assert.equal((await mf.dispatchFetch("https://example.com/articles")).status, 404);
    const closed = await mf.dispatchFetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer fixture-consumer-1",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(closed.status, 503);
    assert.equal((await closed.json()).error, "mcp_not_configured");
    const metadata = await mf.dispatchFetch("https://example.com/.well-known/oauth-protected-resource/mcp");
    assert.equal(metadata.status, 503);
  });
});
