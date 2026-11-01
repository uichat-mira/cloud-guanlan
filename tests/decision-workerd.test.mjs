import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  MCP_TEST_AUDIENCE,
  MCP_TEST_ISSUER,
  MCP_TEST_JWKS_URL,
  MCP_TEST_RESOURCE_URL,
  MCP_TEST_SCOPE,
} from "../dist/mcp-fixtures.mjs";

// GLN-010 T3: real Miniflare/workerd + D1 evidence for the MCP consumption write
// tool. Every call below goes through the real MCP transport with the official
// @modelcontextprotocol/client, never through the domain ledger directly.

const TEST_ID = "00000000-0000-4000-8000-000000000010";
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
  b: "https://news.example.com/b/1",
};

async function withWorker(run, options = {}) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: "dist/mcp-test-worker.mjs",
    compatibilityDate: "2026-08-06",
    cf: false,
    d1Databases: { DB: options.databaseId ?? TEST_ID },
    bindings: FIXTURE_BINDINGS,
    ...(options.persist ? { d1Persist: options.persist } : {}),
  });
  try {
    const db = await mf.getD1Database("DB");
    if (options.migrate !== false) {
      for (const path of MIGRATIONS) {
        const sql = await readFile(path, "utf8");
        for (const statement of sql.split(";").map(s => s.trim()).filter(Boolean)) {
          await db.prepare(statement).run();
        }
      }
    }
    await run({ mf, db });
  } finally {
    await mf.dispose();
  }
}

const source = (id, url) => ["INSERT INTO poc_sources (id,url,interval_hours,due_at) VALUES (?,?,?,?)", [id, url, 1, STAMP]];

async function seedDomain(db) {
  for (const [sql, values] of [
    source("feed-shared", "https://feeds.example.com/shared.xml"),
    source("feed-a1", "https://feeds.example.com/a1.xml"),
    source("feed-a2", "https://feeds.example.com/a2.xml"),
    source("feed-b", "https://feeds.example.com/b.xml"),
  ]) {
    await db.prepare(sql).bind(...values).run();
  }
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

async function addNews(db, url, sourceId, { title, ingestedAt } = {}) {
  await db.prepare(`
    INSERT INTO poc_news (url,source_id,title,summary,published_at,ingested_at)
    VALUES (?,?,?,?,?,?)
  `).bind(
    url,
    sourceId,
    title ?? "Title " + url,
    "Summary " + url,
    "2026-10-31T00:00:00.000Z",
    ingestedAt ?? STAMP,
  ).run();
}

async function seedBaseline(db) {
  await seedDomain(db);
  await addNews(db, NEWS.shared1, "feed-shared", { title: "Shared one", ingestedAt: "2026-11-01T00:01:00.000Z" });
  await addNews(db, NEWS.shared2, "feed-shared", { title: "Shared two", ingestedAt: "2026-11-01T00:02:00.000Z" });
  await addNews(db, NEWS.a1, "feed-a1", { title: "Consumer one private", ingestedAt: "2026-11-01T00:03:00.000Z" });
  await addNews(db, NEWS.b, "feed-b", { title: "Account B private", ingestedAt: "2026-11-01T00:04:00.000Z" });
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
  const client = new Client({ name: "gln010-test", version: "1.0.0" }, options);
  await client.connect(transport);
  return { client, transport };
}

const modern = options => ({ versionNegotiation: { mode: { pin: "2026-07-28" } }, ...options });

const callNews = (client, args = {}) => client.callTool({ name: "guanlan_news_recent", arguments: args });
const callDecide = (client, args) => client.callTool({ name: "guanlan_news_decide", arguments: args });

function itemsOf(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return result.structuredContent.items;
}

function decisionOf(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return result.structuredContent;
}

function errorText(result) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return result.content[0].text;
}

const ledgerCount = async db =>
  (await db.prepare("SELECT count(*) AS n FROM guanlan_consumer_news_states").first()).n;

test("real workerd: the write tool is discoverable, annotated as a write, and requires the write scope", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedBaseline(db);

    const readOnly = await connect(mf, "fixture-consumer-1", modern());
    try {
      const listed = await readOnly.client.listTools();
      assert.deepEqual(
        listed.tools.map(tool => tool.name).sort(),
        ["guanlan_news_decide", "guanlan_news_recent", "guanlan_whoami"],
      );
      const decideTool = listed.tools.find(tool => tool.name === "guanlan_news_decide");
      assert.equal(decideTool.annotations.readOnlyHint, false);
      assert.equal(decideTool.annotations.destructiveHint, false);
      assert.equal(decideTool.annotations.idempotentHint, true);
      for (const tool of listed.tools.filter(candidate => candidate.name !== "guanlan_news_decide")) {
        assert.equal(tool.annotations.readOnlyHint, true);
      }
      // Discovery works, but a read-only credential must never change state.
      const forbidden = await callDecide(readOnly.client, {
        url: NEWS.shared1,
        status: "adopted",
        expectedVersion: 0,
        operationId: "read-only-attempt",
      });
      assert.match(errorText(forbidden), /guanlan_decision_forbidden/);
      assert.match(errorText(forbidden), /guanlan\.write/);
      assert.equal(await ledgerCount(db), 0);

      // Reading itself still works and writes nothing.
      const page = await callNews(readOnly.client, { limit: 50 });
      assert.equal(page.structuredContent.items.find(item => item.url === NEWS.shared1).stateVersion, 0);
      assert.equal(await ledgerCount(db), 0);
    } finally {
      await readOnly.client.close();
    }
  });
});

test("real workerd: authorized read → stateVersion → decide → re-read → replay → conflict", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedBaseline(db);
    const { client } = await connect(mf, "fixture-writer-1", modern());
    try {
      // 1. Authorized read supplies the CAS precondition: unread = 0.
      const before = itemsOf(await callNews(client, { limit: 50 }))
        .find(item => item.url === NEWS.shared1);
      assert.equal(before.status, "unread");
      assert.equal(before.stateVersion, 0);

      // 2. Explicit decision with the observed version.
      const first = decisionOf(await callDecide(client, {
        url: NEWS.shared1,
        status: "adopted",
        expectedVersion: 0,
        operationId: "op-adopt-1",
        reason: "useful for the report",
        outcomeUrl: "https://example.com/report",
      }));
      assert.equal(first.result, "updated");
      assert.equal(first.state.status, "adopted");
      assert.equal(first.state.version, 1);
      assert.equal(first.state.url, NEWS.shared1);
      assert.equal(first.state.reason, "useful for the report");
      assert.equal(first.state.outcomeUrl, "https://example.com/report");
      assert.ok(first.state.decidedAt);
      assert.equal("fingerprint" in first.state, false);
      const firstDecidedAt = first.state.decidedAt;

      // 3. Re-read: the stored decision and its version are visible.
      const history = itemsOf(await callNews(client, { status: ["adopted"], limit: 50 }))
        .find(item => item.url === NEWS.shared1);
      assert.equal(history.status, "adopted");
      assert.equal(history.stateVersion, 1);

      // 4. Retrying the exact same operation is a replayed no-op, not a new version.
      const replay = decisionOf(await callDecide(client, {
        url: NEWS.shared1,
        status: "adopted",
        expectedVersion: 0,
        operationId: "op-adopt-1",
        reason: "useful for the report",
        outcomeUrl: "https://example.com/report",
      }));
      assert.equal(replay.result, "replayed");
      assert.equal(replay.state.version, 1);
      assert.equal(replay.state.decidedAt, firstDecidedAt);

      // 5. A stale expectedVersion is an explicit conflict carrying current truth.
      const stale = await callDecide(client, {
        url: NEWS.shared1,
        status: "ignored",
        expectedVersion: 0,
        operationId: "op-stale",
      });
      const staleText = errorText(stale);
      assert.match(staleText, /guanlan_decision_version_conflict/);
      assert.match(staleText, /"version":1/);
      assert.match(staleText, /"status":"adopted"/);
      assert.equal(await ledgerCount(db), 1);

      // 6. Reusing an operationId for different content is an operation conflict.
      const operationConflict = await callDecide(client, {
        url: NEWS.shared1,
        status: "ignored",
        expectedVersion: 2,
        operationId: "op-adopt-1",
      });
      assert.match(errorText(operationConflict), /guanlan_decision_operation_conflict/);

      // 7. A truthful new decision with the current version advances the version.
      const second = decisionOf(await callDecide(client, {
        url: NEWS.shared1,
        status: "ignored",
        expectedVersion: 1,
        operationId: "op-ignore-2",
      }));
      assert.equal(second.result, "updated");
      assert.equal(second.state.version, 2);
      assert.equal(second.state.status, "ignored");

      // 8. Out-of-order old writes never overwrite the newer decision.
      const late = await callDecide(client, {
        url: NEWS.shared1,
        status: "pending",
        expectedVersion: 1,
        operationId: "op-late",
      });
      assert.match(errorText(late), /guanlan_decision_version_conflict/);
      assert.match(errorText(late), /"version":2/);
      assert.equal(await ledgerCount(db), 1);

      // 9. JSON and Markdown describe the same successful decision.
      const markdown = (await callDecide(client, {
        url: NEWS.shared2,
        status: "pending",
        expectedVersion: 0,
        operationId: "op-markdown",
      })).content[0].text;
      assert.match(markdown, /# Cloud Guanlan decision · updated/);
      assert.match(markdown, /Status: pending/);
      assert.match(markdown, /Version: 1/);
      assert.match(markdown, new RegExp(NEWS.shared2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      await client.close();
    }
  });
});

test("real workerd: decisions are isolated across consumers and accounts", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedBaseline(db);
    const one = await connect(mf, "fixture-writer-1", modern());
    const two = await connect(mf, "fixture-writer-2", modern());
    const b = await connect(mf, "fixture-writer-account-b", modern());
    try {
      // Consumer 1 decides shared1; consumer 2 sees it as unread (version 0).
      decisionOf(await callDecide(one.client, {
        url: NEWS.shared1, status: "adopted", expectedVersion: 0, operationId: "c1-op",
      }));
      const twoBefore = itemsOf(await callNews(two.client, { limit: 50 }))
        .find(item => item.url === NEWS.shared1);
      assert.equal(twoBefore.status, "unread");
      assert.equal(twoBefore.stateVersion, 0);

      // The same URL is independently writable for consumer 2.
      const twoDecision = decisionOf(await callDecide(two.client, {
        url: NEWS.shared1, status: "ignored", expectedVersion: 0, operationId: "c2-op",
      }));
      assert.equal(twoDecision.state.version, 1);

      // Neither consumer's version leaks into the other.
      const oneAfter = itemsOf(await callNews(one.client, { status: ["adopted"], limit: 50 }))
        .find(item => item.url === NEWS.shared1);
      assert.equal(oneAfter.stateVersion, 1);
      assert.equal(oneAfter.status, "adopted");

      // Account B cannot decide a news item from account A's sources.
      const foreign = await callDecide(b.client, {
        url: NEWS.shared1, status: "adopted", expectedVersion: 0, operationId: "b-foreign",
      });
      assert.match(errorText(foreign), /guanlan_decision_not_available/);

      // Account B can decide its own source, and only sees its own version.
      const own = decisionOf(await callDecide(b.client, {
        url: NEWS.b, status: "pending", expectedVersion: 0, operationId: "b-own",
      }));
      assert.equal(own.state.version, 1);
      assert.equal(itemsOf(await callNews(b.client, { status: ["pending"], limit: 50 }))
        .find(item => item.url === NEWS.b).stateVersion, 1);
      assert.equal(await ledgerCount(db), 3);
    } finally {
      await one.client.close();
      await two.client.close();
      await b.client.close();
    }
  });
});

test("real workerd: unknown articles and unauthorized sources share one opaque denial", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedBaseline(db);
    const { client } = await connect(mf, "fixture-writer-1", modern());
    try {
      const unknown = await callDecide(client, {
        url: "https://news.example.com/never-collected",
        status: "adopted",
        expectedVersion: 0,
        operationId: "unknown-op",
      });
      const unauthorized = await callDecide(client, {
        url: NEWS.b,
        status: "adopted",
        expectedVersion: 0,
        operationId: "unauthorized-op",
      });
      const unknownText = errorText(unknown);
      const unauthorizedText = errorText(unauthorized);
      assert.match(unknownText, /guanlan_decision_not_available/);
      assert.equal(unknownText, unauthorizedText, "the tool must not distinguish the two");
      assert.doesNotMatch(unknownText, /news_not_found|source_not_authorized/);
      assert.equal(await ledgerCount(db), 0);
    } finally {
      await client.close();
    }
  });
});

test("real workerd: tool arguments cannot select another account or consumer", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedBaseline(db);
    const one = await connect(mf, "fixture-writer-1", modern());
    const two = await connect(mf, "fixture-writer-2", modern());
    try {
      const result = decisionOf(await callDecide(one.client, {
        url: NEWS.shared1,
        status: "adopted",
        expectedVersion: 0,
        operationId: "spoof-op",
        // Extra, model-supplied fields must not be able to re-target the write.
        accountId: "account-b",
        consumerId: "consumer-2",
      }));
      assert.equal(result.state.version, 1);
      const rows = (await db.prepare(
        "SELECT account_id, consumer_id FROM guanlan_consumer_news_states",
      ).all()).results;
      assert.deepEqual(rows, [{ account_id: "account-a", consumer_id: "consumer-1" }]);
      // Consumer 2 remains unread, proving the write did not land on it.
      const twoPage = itemsOf(await callNews(two.client, { limit: 50 }));
      assert.equal(twoPage.find(item => item.url === NEWS.shared1).stateVersion, 0);
    } finally {
      await one.client.close();
      await two.client.close();
    }
  });
});

test("real workerd: concurrent writes from the same expectedVersion have exactly one winner", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedBaseline(db);
    const a = await connect(mf, "fixture-writer-1", modern());
    const b = await connect(mf, "fixture-writer-1", modern());
    try {
      const [first, second] = await Promise.all([
        callDecide(a.client, {
          url: NEWS.shared2, status: "adopted", expectedVersion: 0, operationId: "concurrent-a",
        }),
        callDecide(b.client, {
          url: NEWS.shared2, status: "ignored", expectedVersion: 0, operationId: "concurrent-b",
        }),
      ]);
      const outcomes = [first, second];
      const winners = outcomes.filter(result => result.isError === undefined);
      const losers = outcomes.filter(result => result.isError === true);
      assert.equal(winners.length, 1, JSON.stringify(outcomes.map(result => result.content)));
      assert.equal(losers.length, 1);
      assert.match(losers[0].content[0].text, /guanlan_decision_version_conflict/);

      const row = await db.prepare(
        "SELECT version, status FROM guanlan_consumer_news_states WHERE news_fingerprint IS NOT NULL",
      ).first();
      assert.equal(row.version, 1);
      assert.equal(row.status, winners[0].structuredContent.state.status);
      assert.equal(await ledgerCount(db), 1);
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });
});

test("real workerd: D1 decisions survive an MCP worker restart and replay across it", async () => {
  const persist = await mkdtemp(join(tmpdir(), "gln010-d1-"));
  try {
    await withWorker(async ({ mf, db }) => {
      await seedBaseline(db);
      const { client } = await connect(mf, "fixture-writer-1", modern());
      try {
        const written = decisionOf(await callDecide(client, {
          url: NEWS.shared1, status: "adopted", expectedVersion: 0, operationId: "restart-op",
          reason: "persisted",
        }));
        assert.equal(written.state.version, 1);
      } finally {
        await client.close();
      }
    }, { persist });

    // A brand-new Miniflare instance over the same persisted D1 directory: no
    // in-process state can explain the replay, only the stored ledger row.
    await withWorker(async ({ mf }) => {
      const { client } = await connect(mf, "fixture-writer-1", modern());
      try {
        const page = itemsOf(await callNews(client, { status: ["adopted"], limit: 50 }))
          .find(item => item.url === NEWS.shared1);
        assert.equal(page.status, "adopted");
        assert.equal(page.stateVersion, 1);
        const replay = decisionOf(await callDecide(client, {
          url: NEWS.shared1, status: "adopted", expectedVersion: 0, operationId: "restart-op",
          reason: "persisted",
        }));
        assert.equal(replay.result, "replayed");
        assert.equal(replay.state.version, 1);
      } finally {
        await client.close();
      }
    }, { persist, migrate: false });
  } finally {
    await rm(persist, { recursive: true, force: true });
  }
});

test("real workerd: a D1 failure is an explicit storage error, not a conflict or denial", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedBaseline(db);
    const { client } = await connect(mf, "fixture-writer-1", modern());
    try {
      await db.prepare("DROP TABLE guanlan_consumer_news_states").run();
      const failed = await callDecide(client, {
        url: NEWS.shared1, status: "adopted", expectedVersion: 0, operationId: "storage-op",
      });
      const text = errorText(failed);
      assert.match(text, /guanlan_decision_unavailable/);
      assert.doesNotMatch(text, /version_conflict|operation_conflict|forbidden|not_available/);

      // The read path keeps its own explicit storage error; the codes never mix.
      const read = await callNews(client, { limit: 5 });
      assert.match(errorText(read), /guanlan_news_unavailable/);
    } finally {
      await client.close();
    }
  });
});

test("real workerd: invalid input, unprovisioned writers and legacy clients stay explicit", async () => {
  await withWorker(async ({ mf, db }) => {
    await seedBaseline(db);
    const writer = await connect(mf, "fixture-writer-1", modern());
    const unprovisioned = await connect(mf, "fixture-writer-unprovisioned", modern());
    const empty = await connect(mf, "fixture-writer-empty", modern());
    try {
      for (const invalid of [
        { url: NEWS.shared1, status: "adopted", expectedVersion: 0 },
        { url: NEWS.shared1, status: "unread", expectedVersion: 0, operationId: "x" },
        { url: NEWS.shared1, status: "adopted", expectedVersion: -1, operationId: "x" },
        { url: NEWS.shared1, status: "adopted", expectedVersion: 0, operationId: "" },
        { url: NEWS.shared1, status: "adopted", expectedVersion: 0, operationId: "x", reason: "x".repeat(501) },
      ]) {
        const result = await callDecide(writer.client, invalid);
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /Input validation error/);
      }
      assert.equal(await ledgerCount(db), 0);

      const missing = await callDecide(unprovisioned.client, {
        url: NEWS.shared1, status: "adopted", expectedVersion: 0, operationId: "unprovisioned",
      });
      assert.match(errorText(missing), /guanlan_principal_unavailable/);

      // An empty subscription set is a positive denial, never an implicit write.
      const noSources = await callDecide(empty.client, {
        url: NEWS.shared1, status: "adopted", expectedVersion: 0, operationId: "empty",
      });
      assert.match(errorText(noSources), /guanlan_decision_not_available/);
      assert.equal(await ledgerCount(db), 0);

      // The 2025-06-18 stateless legacy client reaches the same write tool.
      const legacy = await connect(mf, "fixture-writer-1", { supportedProtocolVersions: ["2025-06-18"] });
      try {
        assert.equal(legacy.client.getProtocolEra(), "legacy");
        const listed = await legacy.client.listTools();
        assert.equal(listed.tools.length, 3);
        const legacyDecision = decisionOf(await callDecide(legacy.client, {
          url: NEWS.a1, status: "adopted", expectedVersion: 0, operationId: "legacy-op",
        }));
        assert.equal(legacyDecision.result, "updated");
        assert.equal(legacyDecision.state.version, 1);
      } finally {
        await legacy.client.close();
      }
    } finally {
      await writer.client.close();
      await unprovisioned.client.close();
      await empty.client.close();
    }
  });
});
