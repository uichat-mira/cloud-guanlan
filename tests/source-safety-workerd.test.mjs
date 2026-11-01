import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { rss } from "./fixtures.mjs";

// GLN-008 T3: the real workerd scheduled path, a real D1 database and an
// isolated service-binding network fixture. No public RSS and no internal
// network target is contacted, so CI is deterministic.
const CRON = "*/5 * * * *";
const APPROVED = "https://developers.cloudflare.com/changelog/rss/index.xml";
const APPROVED_2 = "https://www.cloudflarestatus.com/history.atom";
const now = Date.now();
const overdue = new Date(now - 60_000).toISOString();

const streamOf = (chunks, { stall = false } = {}) => new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    if (!stall) controller.close();
  },
});

async function withWorker(fetcher, run) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: "dist/worker.mjs",
    compatibilityDate: "2026-08-06",
    cf: false,
    d1Databases: { DB: "00000000-0000-4000-8000-000000000081" },
    serviceBindings: { TEST_FEED_FETCHER: async request => fetcher(request) },
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const path of ["migrations/0001_poc.sql", "migrations/0002_source_leases.sql"]) {
      const sql = await readFile(path, "utf8");
      for (const statement of sql.split(";").map(s => s.trim()).filter(Boolean)) {
        await db.prepare(statement).run();
      }
    }
    await run({ mf, db, worker: await mf.getWorker() });
  } finally {
    await mf.dispose();
  }
}

async function seed(db, id, url, due = overdue) {
  await db.prepare("INSERT INTO poc_sources (id,url,interval_hours,due_at) VALUES (?,?,?,?)")
    .bind(id, url, 1, due).run();
}
const tick = worker => worker.scheduled({ cron: CRON, scheduledTime: now });
const newsCount = async db => (await db.prepare("SELECT count(*) AS n FROM poc_news").first()).n;
const sourceRow = (db, id) => db.prepare(
  "SELECT last_status,last_error,retry_count,due_at,lease_token,lease_expires_at FROM poc_sources WHERE id=?",
).bind(id).first();

test("an approved public feed still enters the real workerd collection path", async () => {
  const requested = [];
  await withWorker(async request => {
    requested.push(request.url);
    return new Response(rss(2), { headers: { "content-type": "application/rss+xml" } });
  }, async ({ db, worker }) => {
    await seed(db, "feed-a", APPROVED);
    const outcome = await tick(worker);
    assert.equal(outcome.outcome, "ok");
    assert.deepEqual(requested, [APPROVED]);
    const row = await sourceRow(db, "feed-a");
    assert.equal(row.last_status, "succeeded");
    assert.equal(row.last_error, null);
    assert.equal(row.lease_token, null);
    assert.equal(await newsCount(db), 2);
    assert.ok(Date.parse(row.due_at) > Date.now() + 3_500_000);
  });
});

test("unapproved, private-address and userinfo sources are rejected before any fetch", async () => {
  const cases = [
    ["https://example.com/rss.xml", "source_not_approved"],
    ["https://127.0.0.1/rss.xml", "source_private_address"],
    ["https://[::1]/rss.xml", "source_private_address"],
    ["https://user:pass@www.cloudflarestatus.com/history.atom", "source_userinfo_rejected"],
    ["http://developers.cloudflare.com/changelog/rss/index.xml", "source_scheme_rejected"],
    ["https://localhost/rss.xml", "source_host_rejected"],
  ];
  for (const [url, reason] of cases) {
    let calls = 0;
    await withWorker(async () => {
      calls++;
      return new Response(rss(1));
    }, async ({ db, worker }) => {
      await seed(db, "feed-a", url);
      const outcome = await tick(worker);
      assert.equal(outcome.outcome, "ok");
      assert.equal(calls, 0, `${url} must never reach the network`);
      const row = await sourceRow(db, "feed-a");
      assert.equal(row.last_status, "failed");
      assert.equal(row.last_error, reason);
      assert.equal(row.retry_count, 1);
      assert.equal(row.lease_token, null);
      assert.equal(await newsCount(db), 0);
      assert.ok(Date.parse(row.due_at) >= now + 300_000);
      assert.ok(Date.parse(row.due_at) < Date.now() + 345_000);
    });
  }
});

test("a redirect response is recorded as an error and the Location is never fetched", async () => {
  const requested = [];
  await withWorker(async request => {
    requested.push(request.url);
    return new Response(null, { status: 302, headers: { location: APPROVED_2 } });
  }, async ({ db, worker }) => {
    await seed(db, "feed-a", APPROVED);
    assert.equal((await tick(worker)).outcome, "ok");
    assert.deepEqual(requested, [APPROVED], "manual redirect mode must not follow Location");
    const row = await sourceRow(db, "feed-a");
    assert.equal(row.last_status, "failed");
    assert.equal(row.last_error, "unsupported_redirect");
    assert.equal(await newsCount(db), 0);
  });
});

test("an oversized body without Content-Length is stopped by the streamed limit", async () => {
  // MAX_FEED_BYTES is 128 KiB; the stream is deliberately larger than that and
  // the response declares no length, so only the real byte count can stop it.
  await withWorker(
    async () => new Response(streamOf([new Uint8Array(200_000)])),
    async ({ db, worker }) => {
      await seed(db, "feed-a", APPROVED);
      assert.equal((await tick(worker)).outcome, "ok");
      const row = await sourceRow(db, "feed-a");
      assert.equal(row.last_status, "failed");
      assert.equal(row.last_error, "feed_too_large");
      assert.equal(await newsCount(db), 0);
    },
  );
});

test("a declared Content-Length over the limit is rejected before the body is read", async () => {
  await withWorker(
    async () => new Response("small", { headers: { "content-length": "190000" } }),
    async ({ db, worker }) => {
      await seed(db, "feed-a", APPROVED);
      assert.equal((await tick(worker)).outcome, "ok");
      const row = await sourceRow(db, "feed-a");
      assert.equal(row.last_status, "failed");
      assert.equal(row.last_error, "feed_too_large");
      assert.equal(await newsCount(db), 0);
    },
  );
});

test("a stalled upstream response times out without breaching the collection budget", async () => {
  await withWorker(
    async () => new Response(streamOf([new Uint8Array([60])], { stall: true })),
    async ({ db, worker }) => {
      await seed(db, "feed-a", APPROVED);
      const started = Date.now();
      const outcome = await tick(worker);
      const elapsed = Date.now() - started;
      assert.equal(outcome.outcome, "ok");
      // SOURCE_TIMEOUT_MS is 8s and the invocation wall budget is 16s.
      assert.ok(elapsed >= 7_500, `timed out too early: ${elapsed}ms`);
      assert.ok(elapsed < 16_000, `timeout breached the invocation budget: ${elapsed}ms`);
      const row = await sourceRow(db, "feed-a");
      assert.equal(row.last_status, "failed");
      assert.equal(row.last_error, "fetch_timeout");
      assert.equal(await newsCount(db), 0);
    },
  );
});

test("one failing source does not corrupt another source or delete already-saved news", async () => {
  await withWorker(async request => {
    if (request.url === APPROVED) return new Response(rss(1));
    return new Response("upstream unavailable", { status: 503 });
  }, async ({ db, worker }) => {
    await seed(db, "feed-a", APPROVED);
    await seed(db, "feed-b", APPROVED_2);
    await db.prepare(`
      INSERT INTO poc_news (url,source_id,title,summary,ingested_at) VALUES (?,?,?,?,?)
    `).bind("https://example.com/existing", "feed-b", "Existing", "Saved before failure", overdue).run();

    assert.equal((await tick(worker)).outcome, "ok");

    const succeeded = await sourceRow(db, "feed-a");
    assert.equal(succeeded.last_status, "succeeded");
    const failed = await sourceRow(db, "feed-b");
    assert.equal(failed.last_status, "failed");
    assert.equal(failed.last_error, "feed_http_503");
    assert.equal(failed.retry_count, 1);
    assert.equal(failed.lease_token, null);

    const rows = await db.prepare("SELECT url,source_id FROM poc_news ORDER BY url").all();
    assert.deepEqual(rows.results, [
      { url: "https://example.com/existing", source_id: "feed-b" },
      { url: "https://example.com/story/0?lang=en", source_id: "feed-a" },
    ]);
  });
});

test("persisted failure text is a safe enum and never echoes the source URL", async () => {
  await withWorker(
    async () => new Response("unavailable", { status: 503 }),
    async ({ db, worker }) => {
      await seed(db, "feed-a", APPROVED);
      await tick(worker);
      const row = await sourceRow(db, "feed-a");
      assert.match(row.last_error, /^[a-z0-9_]+$/);
      assert.equal(row.last_error.includes("cloudflare"), false);
      assert.equal(row.last_error.includes("developers"), false);
    },
  );
});
