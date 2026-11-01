import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

// GLN-009 T3: real Miniflare/workerd + D1 evidence for authorized, paginated,
// status-filtered MCP news reading. Uses the real MCP transport (modern and
// legacy stateless clients), never the domain service alone.

const TEST_ID = "00000000-0000-4000-8000-000000000009";
const FIXTURE_BINDINGS = {
  MCP_RESOURCE_URL: MCP_TEST_RESOURCE_URL,
  CLOUD_AUTH_ISSUER: MCP_TEST_ISSUER,
  CLOUD_AUTH_JWKS_URL: MCP_TEST_JWKS_URL,
  MCP_AUDIENCE: MCP_TEST_AUDIENCE,
  MCP_REQUIRED_SCOPES: MCP_TEST_SCOPE,
};
const STAMP = "2026-11-01T00:00:00.000Z";
const MIGRATIONS = [
  "migrations/0001_poc.sql",
  "migrations/0002_source_leases.sql",
  "migrations/0003_guanlan_accounts.sql",
  "migrations/0004_consumer_news_state.sql",
];

const NEWS = {
  shared1: "https://news.example.com/shared/1",
  shared2: "https://news.example.com/shared/2",
  a1: "https://news.example.com/a1/1",
  a2: "https://news.example.com/a2/1",
  b: "https://news.example.com/b/1",
};

async function withWorker(run) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: "dist/mcp-test-worker.mjs",
    compatibilityDate: "2026-08-06",
    cf: false,
    d1Databases: { DB: TEST_ID },
    bindings: FIXTURE_BINDINGS,
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const path of MIGRATIONS) {
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

const source = (id, url) => ["INSERT INTO poc_sources (id,url,interval_hours,due_at) VALUES (?,?,?,?)", [id, url, 1, STAMP]];

async function seedDomain(db) {
  const statements = [
    source("feed-shared", "https://feeds.example.com/shared.xml"),
    source("feed-a1", "https://feeds.example.com/a1.xml"),
    source("feed-a2", "https://feeds.example.com/a2.xml"),
    source("feed-b", "https://feeds.example.com/b.xml"),
  ];
  for (const [sql, values] of statements) await db.prepare(sql).bind(...values).run();

  for (const accountId of ["account-a", "account-b", "account-empty"]) {
    await db.prepare("INSERT INTO guanlan_accounts (account_id,created_at) VALUES (?,?)").bind(accountId, STAMP).run();
  }
  for (const [accountId, consumerId] of [
    ["account-a", "consumer-1"],
    ["account-a", "consumer-2"],
    ["account-b", "consumer-b"],
    ["account-empty", "consumer-empty"],
  ]) {
    await db.prepare("INSERT INTO guanlan_consumers (account_id,consumer_id,created_at) VALUES (?,?,?)")
      .bind(accountId, consumerId, STAMP).run();
  }
  await db.prepare("INSERT INTO guanlan_account_subscriptions (account_id,source_id,interval_hours,created_at) VALUES (?,?,?,?)")
    .bind("account-a", "feed-shared", 1, STAMP).run();
  await db.prepare("INSERT INTO guanlan_account_subscriptions (account_id,source_id,interval_hours,created_at) VALUES (?,?,?,?)")
    .bind("account-b", "feed-b", 1, STAMP).run();
  for (const [consumerId, sourceId] of [["consumer-1", "feed-a1"], ["consumer-2", "feed-a2"]]) {
    await db.prepare("INSERT INTO guanlan_consumer_subscriptions (account_id,consumer_id,source_id,interval_hours,created_at) VALUES (?,?,?,?,?)")
      .bind("account-a", consumerId, sourceId, 1, STAMP).run();
  }
}

async function addNews(db, url, sourceId, { title, summary, publishedAt, ingestedAt } = {}) {
  await db.prepare(`
    INSERT INTO poc_news (url,source_id,title,summary,published_at,ingested_at)
    VALUES (?,?,?,?,?,?)
  `).bind(
    url,
    sourceId,
    title ?? "Title " + url,
    summary ?? "Summary " + url,
    publishedAt === undefined ? "2026-10-31T00:00:00.000Z" : publishedAt,
    ingestedAt ?? STAMP,
  ).run();
}

const fingerprint = url => createHash("sha256").update(url).digest("hex");

async function decide(db, accountId, consumerId, url, status, sourceId) {
  await db.prepare(`
    INSERT INTO guanlan_consumer_news_states (
      account_id, consumer_id, news_fingerprint, source_id,
      status, reason, outcome_url, decided_at, version, last_operation_id
    ) VALUES (?,?,?,?,?,NULL,NULL,?,1,?)
  `).bind(accountId, consumerId, fingerprint(url), sourceId, status, STAMP, "op-" + url).run();
}

async function seedBaseline(db) {
  await seedDomain(db);
  const rows = [
    [NEWS.shared1, "feed-shared", "2026-11-01T00:01:00.000Z", "Shared one"],
    [NEWS.shared2, "feed-shared", "2026-11-01T00:02:00.000Z", "Shared two"],
    [NEWS.a1, "feed-a1", "2026-11-01T00:03:00.000Z", "Consumer one private"],
    [NEWS.a2, "feed-a2", "2026-11-01T00:04:00.000Z", "Consumer two private"],
    [NEWS.b, "feed-b", "2026-11-01T00:05:00.000Z", "Account B private"],
  ];
  for (const [url, sourceId, ingestedAt, title] of rows) {
    await addNews(db, url, sourceId, { title, ingestedAt });
  }
}

function disconnectedFetch(mf) {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return mf.dispatchFetch(url, init);
  };
}

async function connect(mf, token, options = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_TEST_RESOURCE_URL), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: disconnectedFetch(mf),
  });
  const client = new Client({ name: "gln009-test", version: "1.0.0" }, options);
  await client.connect(transport);
  return { client, transport };
}

const modern = options => ({ versionNegotiation: { mode: { pin: "2026-07-28" } }, ...options });

async function callNews(client, args = {}) {
  return client.callTool({ name: "guanlan_news_recent", arguments: args });
}

function itemsOf(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return result.structuredContent.items;
}

async function walk(client, args = {}) {
  const pages = [];
  let cursor;
  for (let i = 0; i < 60; i++) {
    const result = await callNews(client, cursor ? { ...args, cursor } : args);
    const page = result.structuredContent;
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    pages.push(page);
    cursor = page.nextCursor;
    if (!cursor) return pages;
  }
  throw new Error("pagination did not terminate");
}

test("real D1: A/B accounts and A's two consumers only see their effective sources", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedBaseline(db);
    const cases = [
      ["fixture-consumer-1", [NEWS.shared1, NEWS.shared2, NEWS.a1]],
      ["fixture-consumer-2", [NEWS.shared1, NEWS.shared2, NEWS.a2]],
      ["fixture-account-b", [NEWS.b]],
    ];
    for (const [token, expected] of cases) {
      const { client } = await connect(mf, token, modern());
      try {
        const result = await callNews(client, { limit: 50 });
        const urls = itemsOf(result).map(item => item.url);
        assert.deepEqual(new Set(urls), new Set(expected), token);
        for (const item of itemsOf(result)) assert.equal(item.id, item.url);
      } finally {
        await client.close();
      }
    }
  });
});

test("real D1: same URL has a different status per consumer, and history needs an explicit filter", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedBaseline(db);
    await decide(db, "account-a", "consumer-1", NEWS.shared1, "pending", "feed-shared");
    await decide(db, "account-a", "consumer-1", NEWS.shared2, "ignored", "feed-shared");
    await decide(db, "account-a", "consumer-2", NEWS.shared1, "adopted", "feed-shared");

    const a1 = await connect(mf, "fixture-consumer-1", modern());
    const a2 = await connect(mf, "fixture-consumer-2", modern());
    try {
      // Consumer 1 default: unread + pending. shared1 is pending, shared2 is ignored.
      const a1Default = await callNews(a1.client, { limit: 50 });
      const a1Items = itemsOf(a1Default);
      const pendingItem = a1Items.find(item => item.url === NEWS.shared1);
      assert.equal(pendingItem.status, "pending");
      // GLN-010: the page exposes the stored decision version for CAS writes.
      assert.equal(pendingItem.stateVersion, 1);
      assert.equal(a1Items.some(item => item.url === NEWS.shared2), false);
      assert.equal(a1Items.some(item => item.url === NEWS.a2), false);

      // Consumer 1 history: ignored only.
      const a1Ignored = itemsOf(await callNews(a1.client, { status: ["ignored"], limit: 50 }));
      assert.deepEqual(a1Ignored.map(item => [item.url, item.status]), [[NEWS.shared2, "ignored"]]);

      // Consumer 2 default: shared1 is adopted, so it is history for consumer 2.
      const a2Default = itemsOf(await callNews(a2.client, { limit: 50 }));
      assert.equal(a2Default.some(item => item.url === NEWS.shared1), false);
      const unreadItem = a2Default.find(item => item.url === NEWS.shared2);
      assert.equal(unreadItem.status, "unread");
      // No ledger row = implied unread = version 0.
      assert.equal(unreadItem.stateVersion, 0);

      // Consumer 2 history: adopted shared1 only; consumer 1's decisions never leak.
      const a2Adopted = itemsOf(await callNews(a2.client, { status: ["adopted"], limit: 50 }));
      assert.deepEqual(a2Adopted.map(item => [item.url, item.status]), [[NEWS.shared1, "adopted"]]);
      assert.equal(a2Adopted.some(item => item.url === NEWS.shared2), false);
    } finally {
      await a1.client.close();
      await a2.client.close();
    }
  });
});

test("real D1: >50 equal-timestamp rows page with no duplicate and no omission", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedDomain(db);
    const urls = [];
    for (let i = 0; i < 120; i++) {
      const url = `https://news.example.com/page/${String(i).padStart(3, "0")}`;
      urls.push(url);
      await addNews(db, url, "feed-shared", { title: "Item " + i, ingestedAt: STAMP });
    }
    // Every third item is already adopted for consumer 1: the status predicate
    // must be applied to the whole stream, not only to the current page.
    const adopted = urls.filter((_, index) => index % 3 === 0);
    for (const url of adopted) await decide(db, "account-a", "consumer-1", url, "adopted", "feed-shared");

    const { client } = await connect(mf, "fixture-consumer-1", modern());
    try {
      const pages = await walk(client, { limit: 20 });
      const seen = pages.flatMap(page => page.items.map(item => item.url));
      assert.equal(new Set(seen).size, seen.length, "no duplicate across pages");
      assert.deepEqual(new Set(seen), new Set(urls.filter(url => !adopted.includes(url))));
      for (const page of pages) {
        assert.ok(page.count <= 20);
        assert.equal(page.count, page.items.length);
        assert.equal(page.limit, 20);
      }
    } finally {
      await client.close();
    }
  });
});

test("real D1: source, keyword and time filters compose with exact pagination", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedDomain(db);
    const rows = [
      [NEWS.a1, "feed-a1", "Model Context 100%_done", "2026-10-30T00:00:00.000Z", "2026-11-01T01:00:00.000Z"],
      ["https://news.example.com/a1/2", "feed-a1", "model context 100Xdone", "2026-10-30T00:00:00.000Z", "2026-11-01T02:00:00.000Z"],
      ["https://news.example.com/a1/3", "feed-a1", "Unrelated subject", null, "2026-11-01T03:00:00.000Z"],
      ["https://news.example.com/a1/4", "feed-a1", "Model elsewhere", "2026-10-30T00:00:00.000Z", "2026-11-01T04:00:00.000Z"],
      ["https://news.example.com/shared/9", "feed-shared", "Model in shared source", "2026-10-30T00:00:00.000Z", "2026-11-01T05:00:00.000Z"],
    ];
    for (const [url, sourceId, title, publishedAt, ingestedAt] of rows) {
      await addNews(db, url, sourceId, { title, publishedAt, ingestedAt });
    }
    const { client } = await connect(mf, "fixture-consumer-1", modern());
    try {
      // Keyword is literal ASCII-case-insensitive over title and summary.
      const keyword = itemsOf(await callNews(client, { keyword: "MODEL", limit: 50 }));
      assert.deepEqual(new Set(keyword.map(item => item.url)), new Set([
        NEWS.a1, "https://news.example.com/a1/2", "https://news.example.com/a1/4",
        "https://news.example.com/shared/9",
      ]));

      // LIKE metacharacters are literal: 100%_done must not match 100Xdone.
      const literal = itemsOf(await callNews(client, { keyword: "100%_done", limit: 50 }));
      assert.deepEqual(literal.map(item => item.url), [NEWS.a1]);

      // Source filter + keyword + ingested range, paged.
      const pages = await walk(client, {
        limit: 2,
        sourceId: "feed-a1",
        keyword: "model",
        ingestedAfter: "2026-11-01T01:30:00Z",
        ingestedBefore: "2026-11-01T04:00:00Z",
      });
      const filtered = pages.flatMap(page => page.items.map(item => item.url));
      assert.deepEqual(new Set(filtered), new Set(["https://news.example.com/a1/2", "https://news.example.com/a1/4"]));
      for (const page of pages) assert.ok(page.count <= 2);

      // published_at range excludes items without a published time.
      const published = itemsOf(await callNews(client, {
        sourceId: "feed-a1",
        publishedAfter: "2026-10-29T00:00:00Z",
        publishedBefore: "2026-10-31T00:00:00Z",
        limit: 50,
      }));
      assert.deepEqual(new Set(published.map(item => item.url)), new Set([NEWS.a1, "https://news.example.com/a1/2", "https://news.example.com/a1/4"]));
      assert.equal(published.some(item => item.url === "https://news.example.com/a1/3"), false);
    } finally {
      await client.close();
    }
  });
});

test("real D1: a cursor cannot be reused across identities, filter changes, tampering or garbage", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedDomain(db);
    for (let i = 0; i < 5; i++) {
      await addNews(db, `https://news.example.com/cursor/${i}`, "feed-shared", {
        title: "Cursor " + i,
        ingestedAt: `2026-11-01T00:0${i}:00.000Z`,
      });
    }
    const a1 = await connect(mf, "fixture-consumer-1", modern());
    const a2 = await connect(mf, "fixture-consumer-2", modern());
    try {
      const first = await callNews(a1.client, { limit: 2 });
      const cursor = first.structuredContent.nextCursor;
      assert.ok(cursor);

      // Same identity and filters: the cursor continues the stream.
      const continued = await callNews(a1.client, { limit: 2, cursor });
      assert.equal(continued.isError, undefined);
      assert.equal(continued.structuredContent.items.length, 2);

      // Another verified consumer cannot spend this cursor.
      const foreign = await callNews(a2.client, { limit: 2, cursor });
      assert.equal(foreign.isError, true);
      assert.match(foreign.content[0].text, /guanlan_news_cursor_invalid/);

      // Changing the filter set invalidates the cursor.
      const changed = await callNews(a1.client, { limit: 2, cursor, keyword: "cursor" });
      assert.equal(changed.isError, true);
      assert.match(changed.content[0].text, /guanlan_news_cursor_invalid/);

      // A modified cursor is refused.
      const tampered = cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A");
      const tamperedResult = await callNews(a1.client, { limit: 2, cursor: tampered });
      assert.equal(tamperedResult.isError, true);
      assert.match(tamperedResult.content[0].text, /guanlan_news_cursor_invalid/);

      // Garbage is refused, never a silent first page.
      for (const garbage of ["not-a-cursor", "AAAA", "x".repeat(4_000)]) {
        const result = await callNews(a1.client, { limit: 2, cursor: garbage });
        assert.equal(result.isError, true, garbage);
        assert.match(result.content[0].text, /guanlan_news_cursor_invalid/);
      }
    } finally {
      await a1.client.close();
      await a2.client.close();
    }
  });
});

test("real D1: empty subscriptions are an empty page; an unprovisioned subject fails explicitly", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedBaseline(db);
    const empty = await connect(mf, "fixture-empty-account", modern());
    const missing = await connect(mf, "fixture-unprovisioned", modern());
    try {
      const page = await callNews(empty.client, { limit: 20 });
      assert.equal(page.isError, undefined);
      assert.deepEqual(page.structuredContent, { items: [], count: 0, limit: 20, nextCursor: null });

      // An unauthorized source filter is answered with an empty page, so the
      // caller cannot probe whether another account's source exists.
      const probe = await callNews(empty.client, { sourceId: "feed-b" });
      assert.equal(probe.isError, undefined);
      assert.equal(probe.structuredContent.count, 0);

      // Cursor errors are not downgraded to empty success by early exits.
      for (const args of [
        { cursor: "not-a-cursor" },
        { sourceId: "feed-b", cursor: "not-a-cursor" },
      ]) {
        const badCursor = await callNews(empty.client, args);
        assert.equal(badCursor.isError, true);
        assert.match(badCursor.content[0].text, /guanlan_news_cursor_invalid/);
        assert.equal(badCursor.structuredContent, undefined);
      }

      const broken = await callNews(missing.client, { limit: 20 });
      assert.equal(broken.isError, true);
      assert.match(broken.content[0].text, /guanlan_principal_unavailable/);
      assert.equal(broken.structuredContent, undefined);
    } finally {
      await empty.client.close();
      await missing.client.close();
    }
  });
});

test("real D1: a database failure is an explicit tool error, never an empty page", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedBaseline(db);
    const { client } = await connect(mf, "fixture-consumer-1", modern());
    try {
      await db.prepare("DROP TABLE poc_news").run();
      const result = await callNews(client, {});
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /guanlan_news_unavailable/);
      assert.doesNotMatch(result.content[0].text, /No news items/);
      assert.equal(result.structuredContent, undefined);
    } finally {
      await client.close();
    }
  });
});

test("real D1: reading never writes news, leases, subscriptions or the decision ledger", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedBaseline(db);
    await decide(db, "account-a", "consumer-1", NEWS.shared1, "pending", "feed-shared");
    const tables = [
      "poc_sources", "poc_news", "guanlan_accounts", "guanlan_consumers",
      "guanlan_account_subscriptions", "guanlan_consumer_subscriptions",
      "guanlan_account_interests", "guanlan_consumer_interests",
      "guanlan_consumer_news_states",
    ];
    const snapshot = async () => {
      const result = {};
      for (const table of tables) {
        result[table] = (await db.prepare(`SELECT * FROM ${table}`).all()).results;
      }
      return result;
    };
    const before = await snapshot();
    const { client } = await connect(mf, "fixture-consumer-1", modern());
    try {
      await callNews(client, { limit: 50 });
      await callNews(client, { status: ["pending", "adopted", "ignored", "unread"], limit: 50 });
      await callNews(client, { keyword: "shared", limit: 1 });
      await client.callTool({ name: "guanlan_whoami", arguments: {} });
    } finally {
      await client.close();
    }
    assert.deepEqual(await snapshot(), before);
  });
});

test("real D1: modern and legacy stateless clients get the identical page", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedBaseline(db);
    await decide(db, "account-a", "consumer-1", NEWS.shared1, "pending", "feed-shared");
    const modernClient = await connect(mf, "fixture-consumer-1", modern());
    const legacyClient = await connect(mf, "fixture-consumer-1", { supportedProtocolVersions: ["2025-06-18"] });
    try {
      assert.equal(modernClient.client.getProtocolEra(), "modern");
      assert.equal(legacyClient.client.getProtocolEra(), "legacy");
      const query = { limit: 2, status: ["unread", "pending"] };
      const a = await callNews(modernClient.client, query);
      const b = await callNews(legacyClient.client, query);
      assert.deepEqual(b.structuredContent, a.structuredContent);
      assert.equal(b.content[0].text, a.content[0].text);
    } finally {
      await modernClient.client.close();
      await legacyClient.client.close();
    }
  });
});

test("real D1: JSON and Markdown describe the same authorized page", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedBaseline(db);
    await decide(db, "account-a", "consumer-1", NEWS.shared1, "pending", "feed-shared");
    const { client } = await connect(mf, "fixture-consumer-1", modern());
    try {
      const result = await callNews(client, { limit: 1 });
      const page = result.structuredContent;
      const markdown = result.content[0].text;
      assert.equal(page.count, 1);
      assert.match(markdown, new RegExp(`Returned: 1`));
      assert.match(markdown, new RegExp(`Next cursor: ${page.nextCursor ?? "none"}`));
      for (const item of page.items) {
        assert.ok(markdown.includes(item.url), "complete URL identity");
        assert.ok(markdown.includes(`Status: ${item.status}`));
        assert.ok(markdown.includes(`State version: ${item.stateVersion}`));
        assert.ok(markdown.includes(item.title));
        assert.ok(markdown.includes(`Source: ${item.sourceId}`));
      }
    } finally {
      await client.close();
    }
  });
});

test("real D1: a long source id is preserved exactly, not truncated", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedBaseline(db);
    const longSourceId = "feed-" + "s".repeat(295);
    await db.prepare("INSERT INTO poc_sources (id,url,interval_hours,due_at) VALUES (?,?,?,?)")
      .bind(longSourceId, "https://feeds.example.com/long.xml", 1, STAMP).run();
    await db.prepare("INSERT INTO guanlan_consumer_subscriptions (account_id,consumer_id,source_id,interval_hours,created_at) VALUES (?,?,?,?,?)")
      .bind("account-a", "consumer-1", longSourceId, 1, STAMP).run();
    await addNews(db, "https://news.example.com/long-source", longSourceId, {
      title: "Long source id",
      ingestedAt: "2026-11-01T09:00:00.000Z",
    });
    const { client } = await connect(mf, "fixture-consumer-1", modern());
    try {
      const result = await callNews(client, { sourceId: longSourceId, limit: 50 });
      const item = itemsOf(result).find(candidate => candidate.url === "https://news.example.com/long-source");
      assert.ok(item);
      assert.equal(item.sourceId, longSourceId);
      assert.equal(item.sourceId.length, 300);
    } finally {
      await client.close();
    }
  });
});

test("real D1: a source id beyond the explicit output budget fails instead of truncating identity", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedBaseline(db);
    const overlongSourceId = "feed-" + "x".repeat(2_045);
    await db.prepare("INSERT INTO poc_sources (id,url,interval_hours,due_at) VALUES (?,?,?,?)")
      .bind(overlongSourceId, "https://feeds.example.com/overlong.xml", 1, STAMP).run();
    await db.prepare("INSERT INTO guanlan_account_subscriptions (account_id,source_id,interval_hours,created_at) VALUES (?,?,?,?)")
      .bind("account-a", overlongSourceId, 1, STAMP).run();
    await addNews(db, "https://news.example.com/overlong-source", overlongSourceId, {
      title: "Overlong source id",
      ingestedAt: "2026-11-01T23:00:00.000Z",
    });
    const { client } = await connect(mf, "fixture-consumer-1", modern());
    try {
      const result = await callNews(client, { limit: 50 });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /guanlan_news_unavailable/);
      assert.equal(result.structuredContent, undefined);
    } finally {
      await client.close();
    }
  });
});

test("real D1: WHOAMI still reports the token-derived identity and the tool stays read-only", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedBaseline(db);
    const { client } = await connect(mf, "fixture-consumer-1", modern());
    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["guanlan_news_decide", "guanlan_news_recent", "guanlan_whoami"]);
      for (const tool of listed.tools) {
        assert.equal(tool.annotations?.destructiveHint, false);
        if (tool.name !== "guanlan_news_decide") assert.equal(tool.annotations?.readOnlyHint, true);
      }
      const whoami = await client.callTool({ name: "guanlan_whoami", arguments: {} });
      assert.equal(whoami.structuredContent.accountId, "account-a");
      assert.equal(whoami.structuredContent.consumerId, "consumer-1");
      const invalid = await callNews(client, { limit: 51 });
      assert.equal(invalid.isError, true);
      assert.match(invalid.content[0].text, /Input validation error/);
    } finally {
      await client.close();
    }
  });
});
