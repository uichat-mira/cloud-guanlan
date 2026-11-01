import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { rss } from "./fixtures.mjs";
import { createD1SourceRegistry } from "../dist/source-registry.mjs";

// GLN-008 T3: the controlled source admission contract runs against a real
// workerd/D1 database, not a Node SQLite stand-in.
const MIGRATIONS = [
  "migrations/0001_poc.sql",
  "migrations/0002_source_leases.sql",
  "migrations/0003_guanlan_accounts.sql",
];
const APPROVED = "https://developers.cloudflare.com/changelog/rss/index.xml";
const APPROVED_2 = "https://www.cloudflarestatus.com/history.atom";
const stamp = "2026-11-01T00:00:00.000Z";

async function withD1(fn, { fetcher } = {}) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: "dist/worker.mjs",
    compatibilityDate: "2026-08-06",
    cf: false,
    d1Databases: { DB: "00000000-0000-4000-8000-000000000082" },
    ...(fetcher ? { serviceBindings: { TEST_FEED_FETCHER: async request => fetcher(request) } } : {}),
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const path of MIGRATIONS) {
      const sql = await readFile(path, "utf8");
      for (const statement of sql.split(";").map(s => s.trim()).filter(Boolean)) {
        await db.prepare(statement).run();
      }
    }
    await fn({ mf, db, worker: await mf.getWorker() });
  } finally {
    await mf.dispose();
  }
}

const rows = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
const countSources = async db => (await db.prepare("SELECT count(*) AS n FROM poc_sources").first()).n;

test("registering an approved public feed creates one shared collection row", async () => {
  await withD1(async ({ db }) => {
    const registry = createD1SourceRegistry(db);
    const result = await registry.register({ url: APPROVED, intervalHours: 2 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.created, true);
    assert.match(result.sourceId, /^src_[0-9a-f]{16}$/);
    assert.equal(result.url, APPROVED);
    assert.equal(result.intervalHours, 2);

    const stored = await rows(db, "SELECT id,url,interval_hours,due_at,last_status FROM poc_sources");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, result.sourceId);
    assert.equal(stored[0].url, APPROVED);
    assert.equal(stored[0].interval_hours, 2);
    assert.equal(stored[0].last_status, null);
    assert.ok(Number.isFinite(Date.parse(stored[0].due_at)));
  });
});

test("duplicate approval of the same canonical URL never creates a second collection task", async () => {
  await withD1(async ({ db }) => {
    const registry = createD1SourceRegistry(db);
    const first = await registry.register({ url: APPROVED, intervalHours: 2 });
    assert.equal(first.ok, true);
    const dueAt = (await rows(db, "SELECT due_at FROM poc_sources WHERE url=?", APPROVED))[0].due_at;

    const again = await registry.register({ url: APPROVED, intervalHours: 8 });
    assert.equal(again.ok, true);
    assert.equal(again.created, false);
    assert.equal(again.sourceId, first.sourceId);
    // Admission is not scheduling configuration: the stored interval and due
    // time are not rewritten by a duplicate approval.
    assert.equal(again.intervalHours, 2);
    assert.equal((await rows(db, "SELECT due_at FROM poc_sources WHERE url=?", APPROVED))[0].due_at, dueAt);

    // Case and default-port normalization map to the same stored row too.
    const normalized = await registry.register({
      url: "HTTPS://WWW.CloudflareStatus.COM:443/history.atom#top",
      intervalHours: 1,
    });
    assert.equal(normalized.ok, true);
    assert.equal(normalized.url, APPROVED_2);
    const normalizedAgain = await registry.register({ url: APPROVED_2, intervalHours: 3 });
    assert.equal(normalizedAgain.created, false);
    assert.equal(normalizedAgain.sourceId, normalized.sourceId);

    assert.equal(await countSources(db), 2);
    assert.deepEqual(
      (await rows(db, "SELECT url FROM poc_sources ORDER BY url")).map(row => row.url),
      [APPROVED, APPROVED_2],
    );
  });
});

test("unapproved, unsafe or malformed registrations are rejected without writing", async () => {
  await withD1(async ({ db }) => {
    const registry = createD1SourceRegistry(db);
    const cases = [
      [{ url: "https://example.com/rss.xml", intervalHours: 1 }, "source_not_approved"],
      [{ url: "https://127.0.0.1/rss.xml", intervalHours: 1 }, "source_private_address"],
      [{ url: "https://[::1]/rss.xml", intervalHours: 1 }, "source_private_address"],
      [{ url: "http://developers.cloudflare.com/changelog/rss/index.xml", intervalHours: 1 }, "source_scheme_rejected"],
      [{ url: "https://user:pass@www.cloudflarestatus.com/history.atom", intervalHours: 1 }, "source_userinfo_rejected"],
      [{ url: "https://localhost/rss.xml", intervalHours: 1 }, "source_host_rejected"],
      [{ url: "not a url", intervalHours: 1 }, "source_url_invalid"],
      [{ url: 42, intervalHours: 1 }, "source_url_invalid"],
      [null, "source_url_invalid"],
      [[], "source_url_invalid"],
      [{ url: APPROVED, intervalHours: 0 }, "source_interval_invalid"],
      [{ url: APPROVED, intervalHours: 25 }, "source_interval_invalid"],
      [{ url: APPROVED, intervalHours: 1.5 }, "source_interval_invalid"],
      [{ url: APPROVED, intervalHours: "1" }, "source_interval_invalid"],
      [{ url: APPROVED }, "source_interval_invalid"],
    ];
    for (const [input, reason] of cases) {
      const result = await registry.register(input);
      assert.equal(result.ok, false, JSON.stringify(input));
      assert.equal(result.reason, reason, JSON.stringify(input));
      assert.equal("sourceId" in result, false);
    }
    assert.equal(await countSources(db), 0);
  });
});

test("registration never writes account or consumer subscription data", async () => {
  await withD1(async ({ db }) => {
    const insert = (sql, ...values) => db.prepare(sql).bind(...values).run();
    await insert("INSERT INTO guanlan_accounts(account_id,created_at) VALUES(?,?)", "account-a", stamp);
    await insert("INSERT INTO guanlan_consumers(account_id,consumer_id,created_at) VALUES(?,?,?)",
      "account-a", "research", stamp);
    await insert("INSERT INTO poc_sources(id,url,interval_hours,due_at) VALUES(?,?,?,?)",
      "existing", APPROVED_2, 1, stamp);
    await insert("INSERT INTO guanlan_account_subscriptions(account_id,source_id,created_at) VALUES(?,?,?)",
      "account-a", "existing", stamp);
    await insert("INSERT INTO guanlan_account_interests(account_id,kind,value,created_at) VALUES(?,?,?,?)",
      "account-a", "keyword", "Science", stamp);

    const tables = [
      "guanlan_accounts", "guanlan_consumers", "guanlan_account_subscriptions",
      "guanlan_consumer_subscriptions", "guanlan_account_interests", "guanlan_consumer_interests",
    ];
    const snapshot = async () => {
      const out = {};
      for (const table of tables) out[table] = await rows(db, `SELECT * FROM ${table} ORDER BY 1,2`);
      return out;
    };
    const before = await snapshot();

    const result = await createD1SourceRegistry(db).register({ url: APPROVED, intervalHours: 1 });
    assert.equal(result.ok, true);

    assert.deepEqual(await snapshot(), before);
    // The public source catalog stays separate from private subscription rows.
    assert.equal((await rows(db, "SELECT count(*) AS n FROM poc_sources"))[0].n, 2);
    assert.deepEqual(await rows(db, "PRAGMA foreign_key_check"), []);
  });
});

test("a registered approved source is collected by the real workerd Cron path", async () => {
  const requested = [];
  await withD1(async ({ db, worker }) => {
    const registered = await createD1SourceRegistry(db).register({ url: APPROVED, intervalHours: 1 });
    assert.equal(registered.ok, true);
    const first = await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() });
    assert.equal(first.outcome, "ok");
    assert.deepEqual(requested, [APPROVED]);
    const row = await db.prepare(
      "SELECT last_status,last_error,lease_token FROM poc_sources WHERE id=?",
    ).bind(registered.sourceId).first();
    assert.equal(row.last_status, "succeeded");
    assert.equal(row.last_error, null);
    assert.equal(row.lease_token, null);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM poc_news").first()).n, 2);

    // A second tick inside the hourly window must not refetch or duplicate.
    const second = await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() });
    assert.equal(second.outcome, "ok");
    assert.equal(requested.length, 1);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM poc_news").first()).n, 2);
  }, {
    fetcher: async request => {
      requested.push(request.url);
      return new Response(rss(2), { headers: { "content-type": "application/rss+xml" } });
    },
  });
});

test("concurrent duplicate registrations resolve to one stored source", async () => {
  await withD1(async ({ db }) => {
    const registry = createD1SourceRegistry(db);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => registry.register({ url: APPROVED, intervalHours: 1 })),
    );
    assert.equal(results.every(result => result.ok), true, JSON.stringify(results));
    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal(new Set(results.map(result => result.sourceId)).size, 1);
    assert.equal(await countSources(db), 1);
  });
});
