import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

// GLN-005 / GLN-007: exercise actual workerd/D1, never an in-memory Node SQLite mock.
const MIGRATIONS = [
  "migrations/0001_poc.sql",
  "migrations/0002_source_leases.sql",
  "migrations/0003_guanlan_accounts.sql",
  "migrations/0004_consumer_news_state.sql",
];
const stamp = "2026-11-01T00:00:00.000Z";

async function withD1(fn) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: "dist/worker.mjs",
    compatibilityDate: "2026-08-06",
    cf: false,
    d1Databases: { DB: "00000000-0000-4000-8000-000000000011" },
  });
  try {
    await fn(await mf.getD1Database("DB"), mf);
  } finally {
    await mf.dispose();
  }
}

async function apply(db, files) {
  // Wrangler owns migration bookkeeping; no ad hoc migrations ledger.
  for (const path of files) {
    const sql = await readFile(path, "utf8");
    for (const statement of sql.split(";").map(s => s.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}
const insert = (db, sql, ...values) => db.prepare(sql).bind(...values).run();
async function reject(db, sql, ...values) {
  await assert.rejects(insert(db, sql, ...values));
}
const values = async (db, sql, ...args) =>
  (await db.prepare(sql).bind(...args).all()).results;

async function seedSources(db) {
  for (const id of ["shared", "account-only", "consumer-only", "other-only"]) {
    await insert(db,
      "INSERT INTO poc_sources(id,url,interval_hours,due_at) VALUES(?,?,?,?)",
      id, "https://example.com/" + id + ".xml", 1, stamp);
  }
}
async function seedOwners(db) {
  for (const account of ["account-a", "account-b"]) {
    await insert(db,
      "INSERT INTO guanlan_accounts(account_id,created_at) VALUES(?,?)", account, stamp);
  }
  for (const [account, consumer] of [
    ["account-a","research"], ["account-a","radar"], ["account-b","radar"],
  ]) {
    await insert(db,
      "INSERT INTO guanlan_consumers(account_id,consumer_id,created_at) VALUES(?,?,?)",
      account, consumer, stamp);
  }
}
const accountSub = (db, account, source) => insert(db,
  "INSERT INTO guanlan_account_subscriptions(account_id,source_id,created_at) VALUES(?,?,?)",
  account, source, stamp);
const consumerSub = (db, account, consumer, source) => insert(db,
  "INSERT INTO guanlan_consumer_subscriptions(account_id,consumer_id,source_id,created_at) VALUES(?,?,?,?)",
  account, consumer, source, stamp);
const accountInterest = (db, account, kind, value) => insert(db,
  "INSERT INTO guanlan_account_interests(account_id,kind,value,created_at) VALUES(?,?,?,?)",
  account, kind, value, stamp);
const consumerInterest = (db, account, consumer, kind, value) => insert(db,
  "INSERT INTO guanlan_consumer_interests(account_id,consumer_id,kind,value,created_at) VALUES(?,?,?,?,?)",
  account, consumer, kind, value, stamp);
const sourceIds = async (db, account, consumer) =>
  (await values(db, `
    SELECT source_id FROM guanlan_account_subscriptions WHERE account_id=?
    UNION
    SELECT source_id FROM guanlan_consumer_subscriptions
      WHERE account_id=? AND consumer_id=?
    ORDER BY source_id
  `, account, account, consumer)).map(r => r.source_id);
const interests = async (db, account, consumer) =>
  (await values(db, `
    SELECT kind,value FROM guanlan_account_interests WHERE account_id=?
    UNION
    SELECT kind,value FROM guanlan_consumer_interests
      WHERE account_id=? AND consumer_id=?
    ORDER BY kind,value
  `, account, account, consumer)).map(r => r.kind + ":" + r.value);

test("fresh D1 migration: two accounts, stable consumers and inherited vs private configuration", async () => {
  await withD1(async db => {
    await apply(db, MIGRATIONS);
    await seedSources(db);
    await seedOwners(db);
    await accountSub(db, "account-a", "shared");
    await accountSub(db, "account-a", "account-only");
    await accountSub(db, "account-b", "shared"); // reused public source, private subscription
    await consumerSub(db, "account-a", "research", "consumer-only");
    await consumerSub(db, "account-b", "radar", "other-only");
    await accountInterest(db, "account-a", "keyword", "Science");
    await consumerInterest(db, "account-a", "research", "topic", "Space");
    await consumerInterest(db, "account-a", "radar", "topic", "Culture");
    assert.deepEqual(await sourceIds(db,"account-a","research"),
      ["account-only","consumer-only","shared"]);
    assert.deepEqual(await sourceIds(db,"account-a","radar"),
      ["account-only","shared"]);
    assert.deepEqual(await sourceIds(db,"account-b","radar"),
      ["other-only","shared"]);
    assert.deepEqual(await interests(db,"account-a","research"),
      ["keyword:Science","topic:Space"]);
    assert.deepEqual(await interests(db,"account-a","radar"),
      ["keyword:Science","topic:Culture"]);
    assert.deepEqual(await interests(db,"account-b","radar"),[]);
    assert.deepEqual(await values(db,"PRAGMA foreign_key_check"),[]);
  });
});

test("actual D1 foreign keys, compound ownership and uniqueness reject cross-account or invalid relations", async () => {
  await withD1(async db => {
    await apply(db, MIGRATIONS);
    await seedSources(db);
    await seedOwners(db);
    await consumerSub(db, "account-a", "research", "shared");

    await reject(db,
      "INSERT INTO guanlan_consumers(account_id,consumer_id,created_at) VALUES(?,?,?)",
      "missing-account","research",stamp);
    await reject(db,
      "INSERT INTO guanlan_consumers(account_id,consumer_id,created_at) VALUES(?,?,?)",
      "account-a","research",stamp);
    await reject(db,
      "INSERT INTO guanlan_consumer_subscriptions(account_id,consumer_id,source_id,created_at) VALUES(?,?,?,?)",
      "account-b","research","shared",stamp); // consumer exists only under account-a
    await reject(db,
      "INSERT INTO guanlan_consumer_subscriptions(account_id,consumer_id,source_id,created_at) VALUES(?,?,?,?)",
      "account-a","missing","shared",stamp);
    await reject(db,
      "INSERT INTO guanlan_consumer_subscriptions(account_id,consumer_id,source_id,created_at) VALUES(?,?,?,?)",
      "account-a","research","unknown-source",stamp);
    await reject(db,
      "INSERT INTO guanlan_consumer_subscriptions(account_id,consumer_id,source_id,created_at) VALUES(?,?,?,?)",
      "account-a","research","shared",stamp);
    await reject(db,
      "INSERT INTO guanlan_account_subscriptions(account_id,source_id,created_at) VALUES(?,?,?)",
      "missing-account","shared",stamp);
    await reject(db,
      "INSERT INTO guanlan_account_subscriptions(account_id,source_id,created_at) VALUES(?,?,?)",
      "account-a","missing-source",stamp);
    await accountInterest(db, "account-a", "keyword", "Science");
    await reject(db,
      "INSERT INTO guanlan_account_interests(account_id,kind,value,created_at) VALUES(?,?,?,?)",
      "account-a","keyword","science",stamp); // NOCASE unique
    await reject(db,
      "INSERT INTO guanlan_account_interests(account_id,kind,value,created_at) VALUES(?,?,?,?)",
      "account-a","invalid","Science",stamp);
    await reject(db,
      "INSERT INTO guanlan_account_interests(account_id,kind,value,created_at) VALUES(?,?,?,?)",
      "account-a","topic","  padded  ",stamp);
    await reject(db,
      "INSERT INTO guanlan_consumer_interests(account_id,consumer_id,kind,value,created_at) VALUES(?,?,?,?,?)",
      "account-b","research","keyword","Science",stamp);
    assert.deepEqual(await values(db,"PRAGMA foreign_key_check"),[]);
    assert.equal((await values(db,
      "SELECT COUNT(*) AS n FROM guanlan_consumer_subscriptions"))[0].n,1);
  });
});

test("upgrading populated 0001/0002 D1 preserves news, source lease and Cron read path", async () => {
  await withD1(async (db,mf) => {
    await apply(db, MIGRATIONS.slice(0,2));
    await insert(db,
      "INSERT INTO poc_sources(id,url,interval_hours,due_at,lease_token,lease_expires_at,retry_count,last_status) VALUES(?,?,?,?,?,?,?,?)",
      "legacy","https://example.com/legacy.xml",2,stamp,"lease-legacy",
      "2026-11-01T00:01:00.000Z",3,"failed");
    await insert(db,
      "INSERT INTO poc_news(url,source_id,title,summary,ingested_at) VALUES(?,?,?,?,?)",
      "https://example.com/news/1","legacy","Legacy story","Summary",stamp);
    const beforeSource = (await values(db,"SELECT * FROM poc_sources WHERE id='legacy'"))[0];
    const beforeNews = (await values(db,"SELECT * FROM poc_news WHERE source_id='legacy'"))[0];
    await apply(db,MIGRATIONS.slice(2));
    assert.deepEqual((await values(db,"SELECT * FROM poc_sources WHERE id='legacy'"))[0],beforeSource);
    assert.deepEqual((await values(db,"SELECT * FROM poc_news WHERE source_id='legacy'"))[0],beforeNews);
    await seedOwners(db);
    await accountSub(db,"account-a","legacy");
    assert.deepEqual(await sourceIds(db,"account-a","radar"),["legacy"]);
    assert.deepEqual(await values(db,"PRAGMA foreign_key_check"),[]);
    // The Worker remains configured with no Cloud Auth: only health is public.
    const health = await mf.dispatchFetch("https://example.com/health");
    assert.equal(health.status,200);
    const publicNews = await mf.dispatchFetch("https://example.com/articles");
    assert.equal(publicNews.status,404);
    const mcp = await mf.dispatchFetch("https://example.com/mcp",{method:"POST"});
    assert.equal(mcp.status,503);
    const oldRow = (await values(db,
      "SELECT source_id, title FROM poc_news WHERE url=?", "https://example.com/news/1"))[0];
    assert.deepEqual(oldRow,{source_id:"legacy",title:"Legacy story"});
  });
});

test("GLN-007 upgrade: populated 0001..0003 gains the ledger without rewriting existing rows", async () => {
  await withD1(async db => {
    // Forward upgrade from the exact schema a deployed GLN-005/GLN-006 database
    // has, including live sources, news, accounts, consumers, subscriptions and
    // interests. Nothing is dropped or recreated.
    await apply(db, MIGRATIONS.slice(0, 3));
    await seedSources(db);
    await insert(db,
      "INSERT INTO poc_news(url,source_id,title,summary,published_at,ingested_at) VALUES(?,?,?,?,?,?)",
      "https://example.com/news/legacy","shared","Legacy story","Summary",stamp,stamp);
    await seedOwners(db);
    await accountSub(db,"account-a","shared");
    await consumerSub(db,"account-a","research","consumer-only");
    await accountInterest(db,"account-a","keyword","Science");
    await consumerInterest(db,"account-a","research","topic","Space");

    const tables = [
      "poc_sources","poc_news","guanlan_accounts","guanlan_consumers",
      "guanlan_account_subscriptions","guanlan_consumer_subscriptions",
      "guanlan_account_interests","guanlan_consumer_interests",
    ];
    const snapshot = async () => {
      const out = {};
      for (const table of tables) {
        out[table] = await values(db, `SELECT * FROM ${table} ORDER BY 1,2`);
      }
      return out;
    };
    const before = await snapshot();

    await apply(db, MIGRATIONS.slice(3));

    assert.deepEqual(await snapshot(), before);
    // `unread` is the absence of a record: the migration backfills nothing.
    assert.deepEqual(await values(db,
      "SELECT COUNT(*) AS n FROM guanlan_consumer_news_states"),[{n:0}]);
    assert.deepEqual(await values(db,"PRAGMA foreign_key_check"),[]);

    // The new composite FK is tenant-bound on the upgraded database.
    const insertState = (account, consumer, fingerprint) => insert(db, `
      INSERT INTO guanlan_consumer_news_states (
        account_id, consumer_id, news_fingerprint, source_id,
        status, reason, outcome_url, decided_at, version, last_operation_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `, account, consumer, fingerprint, "shared", "pending", null, null, stamp, 1, "op-upgrade");
    await insertState("account-a","research","a".repeat(64));
    // `research` exists only under account-a.
    await reject(db, `
      INSERT INTO guanlan_consumer_news_states (
        account_id, consumer_id, news_fingerprint, source_id,
        status, reason, outcome_url, decided_at, version, last_operation_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `, "account-b", "research", "b".repeat(64), "shared", "pending", null, null, stamp, 1, "op-upgrade");
    assert.equal((await values(db,
      "SELECT COUNT(*) AS n FROM guanlan_consumer_news_states"))[0].n,1);
  });
});
