import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import {
  SubscriptionReadError,
  createD1SubscriptionReader,
  subjectFromPrincipal,
} from "../dist/subscriptions-unit.mjs";

// GLN-006 T3: the domain reader runs against a real workerd/D1 database, not an
// in-memory Node SQLite stand-in. Miniflare owns the database; the reader is the
// same module the Worker imports.
const MIGRATIONS = [
  "migrations/0001_poc.sql",
  "migrations/0002_source_leases.sql",
  "migrations/0003_guanlan_accounts.sql",
];
const stamp = "2026-11-01T00:00:00.000Z";

async function withD1(fn) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: "dist/worker.mjs",
    compatibilityDate: "2026-08-06",
    cf: false,
    d1Databases: { DB: "00000000-0000-4000-8000-000000000013" },
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const path of MIGRATIONS) {
      const sql = await readFile(path, "utf8");
      for (const statement of sql.split(";").map(s => s.trim()).filter(Boolean)) {
        await db.prepare(statement).run();
      }
    }
    await fn(db);
  } finally {
    await mf.dispose();
  }
}

const insert = (db, sql, ...values) => db.prepare(sql).bind(...values).run();
const rows = async (db, sql, ...values) => (await db.prepare(sql).bind(...values).all()).results;
const principal = (accountId, consumerId) => ({
  accountId,
  consumerId,
  scopes: ["guanlan.read"],
  expiresAt: 4_102_444_800,
  issuer: "mira:cloud-auth",
  audience: "mira:cloud-guanlan",
});
const readOf = async (db, accountId, consumerId) => {
  const read = await createD1SubscriptionReader(db)
    .read(subjectFromPrincipal(principal(accountId, consumerId)));
  assert.equal(read.ok, true, `${accountId}/${consumerId} should be readable`);
  return read.effective;
};

async function seed(db) {
  for (const id of ["shared", "account-only", "consumer-only", "other-only", "pref-high"]) {
    await insert(db,
      "INSERT INTO poc_sources(id,url,interval_hours,due_at) VALUES(?,?,?,?)",
      id, "https://example.com/" + id + ".xml", 1, stamp);
  }
  await insert(db,
    "INSERT INTO poc_news(url,source_id,title,summary,ingested_at) VALUES(?,?,?,?,?)",
    "https://example.com/story", "shared", "Global story", "Summary", stamp);

  for (const account of ["account-a", "account-b", "account-c"]) {
    await insert(db, "INSERT INTO guanlan_accounts(account_id,created_at) VALUES(?,?)", account, stamp);
  }
  for (const [account, consumer] of [
    ["account-a", "research"], ["account-a", "radar"],
    ["account-b", "radar"], ["account-c", "solo"],
  ]) {
    await insert(db,
      "INSERT INTO guanlan_consumers(account_id,consumer_id,created_at) VALUES(?,?,?)",
      account, consumer, stamp);
  }

  const accountSub = (account, source, interval) => insert(db,
    "INSERT INTO guanlan_account_subscriptions(account_id,source_id,interval_hours,created_at) VALUES(?,?,?,?)",
    account, source, interval, stamp);
  const consumerSub = (account, consumer, source, interval) => insert(db,
    "INSERT INTO guanlan_consumer_subscriptions(account_id,consumer_id,source_id,interval_hours,created_at) VALUES(?,?,?,?,?)",
    account, consumer, source, interval, stamp);
  const accountInterest = (account, kind, value) => insert(db,
    "INSERT INTO guanlan_account_interests(account_id,kind,value,created_at) VALUES(?,?,?,?)",
    account, kind, value, stamp);
  const consumerInterest = (account, consumer, kind, value) => insert(db,
    "INSERT INTO guanlan_consumer_interests(account_id,consumer_id,kind,value,created_at) VALUES(?,?,?,?,?)",
    account, consumer, kind, value, stamp);

  await accountSub("account-a", "shared", 4);
  await accountSub("account-a", "account-only", 2);
  await accountSub("account-b", "shared", 3);
  // Consumer preference must win in both directions, not by min/max: this
  // source is subscribed at account 2h and consumer 8h, so 8h proves the rule.
  await accountSub("account-a", "pref-high", 2);
  await consumerSub("account-a", "research", "pref-high", 8);
  await consumerSub("account-a", "research", "shared", 1);
  await consumerSub("account-a", "research", "consumer-only", 1);
  await consumerSub("account-b", "radar", "other-only", 1);
  await accountInterest("account-a", "keyword", "Science");
  await accountInterest("account-a", "topic", "Space");
  await accountInterest("account-b", "keyword", "Finance");
  await consumerInterest("account-a", "research", "keyword", "SCIENCE");
  await consumerInterest("account-a", "research", "topic", "Robotics");
  await consumerInterest("account-a", "radar", "topic", "Culture");
}

const TABLES = [
  "guanlan_accounts",
  "guanlan_consumers",
  "guanlan_account_subscriptions",
  "guanlan_consumer_subscriptions",
  "guanlan_account_interests",
  "guanlan_consumer_interests",
  "poc_sources",
  "poc_news",
];
async function snapshot(db) {
  const out = {};
  for (const table of TABLES) {
    out[table] = await rows(db, `SELECT * FROM ${table} ORDER BY 1,2`);
  }
  return out;
}

test("real D1: two accounts sharing one source each inherit only their own configuration", async () => {
  await withD1(async db => {
    await seed(db);

    const research = await readOf(db, "account-a", "research");
    assert.deepEqual(research.sourceIds, ["account-only", "consumer-only", "pref-high", "shared"]);
    assert.deepEqual(research.sources, [
      { sourceId: "account-only", origin: "account", intervalHours: 2, intervalSource: "account" },
      { sourceId: "consumer-only", origin: "consumer", intervalHours: 1, intervalSource: "consumer" },
      // Consumer preference wins upward too (account 2h, consumer 8h → 8h).
      { sourceId: "pref-high", origin: "both", intervalHours: 8, intervalSource: "consumer" },
      { sourceId: "shared", origin: "both", intervalHours: 1, intervalSource: "consumer" },
    ]);
    assert.deepEqual(research.interests, [
      { kind: "keyword", value: "Science", origin: "both" },
      { kind: "topic", value: "Robotics", origin: "consumer" },
      { kind: "topic", value: "Space", origin: "account" },
    ]);

    // Same account, sibling consumer: account baseline only.
    const radarA = await readOf(db, "account-a", "radar");
    assert.deepEqual(radarA.sourceIds, ["account-only", "pref-high", "shared"]);
    assert.deepEqual(radarA.sources.map(s => [s.sourceId, s.intervalHours, s.intervalSource]), [
      ["account-only", 2, "account"],
      ["pref-high", 2, "account"],
      ["shared", 4, "account"],
    ]);
    assert.deepEqual(radarA.interests, [
      { kind: "keyword", value: "Science", origin: "account" },
      { kind: "topic", value: "Culture", origin: "consumer" },
      { kind: "topic", value: "Space", origin: "account" },
    ]);

    // Same consumer label under another account is a different tenant.
    const radarB = await readOf(db, "account-b", "radar");
    assert.deepEqual(radarB.sourceIds, ["other-only", "shared"]);
    assert.deepEqual(radarB.sources.map(s => [s.sourceId, s.intervalHours, s.intervalSource]), [
      ["other-only", 1, "consumer"],
      ["shared", 3, "account"],
    ]);
    assert.deepEqual(radarB.interests, [{ kind: "keyword", value: "Finance", origin: "account" }]);

    // The shared public source is stored once and reused; no read duplicates it.
    assert.equal((await rows(db, "SELECT id FROM poc_sources WHERE id='shared'")).length, 1);
    assert.equal((await rows(db, "SELECT COUNT(*) AS n FROM poc_sources"))[0].n, 5);
    assert.equal(new Set(research.sourceIds).size, research.sourceIds.length);
    assert.equal(new Set(radarB.sourceIds).size, radarB.sourceIds.length);
  });
});

test("real D1: unknown, foreign or mismatched subjects fail closed without leaking another account", async () => {
  await withD1(async db => {
    await seed(db);
    const reader = createD1SubscriptionReader(db);

    const cases = [
      [{ accountId: "missing-account", consumerId: "research" }, "account_not_found"],
      [{ accountId: "account-a", consumerId: "missing-consumer" }, "consumer_not_found"],
      // `solo` exists, but only under account-c.
      [{ accountId: "account-a", consumerId: "solo" }, "consumer_not_found"],
      // `research` exists, but only under account-a.
      [{ accountId: "account-b", consumerId: "research" }, "consumer_not_found"],
      [{ accountId: "account-c", consumerId: "radar" }, "consumer_not_found"],
    ];
    for (const [identity, failure] of cases) {
      const read = await reader.read(subjectFromPrincipal(principal(identity.accountId, identity.consumerId)));
      assert.equal(read.ok, false, `${identity.accountId}/${identity.consumerId}`);
      assert.equal(read.failure, failure);
      assert.equal("effective" in read, false);
    }

    // A mismatched subject (real consumer label, wrong account) cannot borrow
    // the other account's configuration. What this port does *not* prove: a
    // subject naming a real pair succeeds, so provenance — the verifier that
    // produced the principal — is what stops naming someone else's pair.
    const mismatched = await reader.read(subjectFromPrincipal(principal("account-b", "research")));
    assert.deepEqual(mismatched, { ok: false, failure: "consumer_not_found" });
  });
});

test("real D1: an empty subscriber sees zero sources even though global news exists", async () => {
  await withD1(async db => {
    await seed(db);
    assert.equal((await rows(db, "SELECT COUNT(*) AS n FROM poc_news"))[0].n, 1);

    const solo = await readOf(db, "account-c", "solo");
    assert.deepEqual(solo.sources, []);
    assert.deepEqual(solo.sourceIds, []);
    assert.deepEqual(solo.interests, []);
    assert.equal("items" in solo, false);

    // Prove there is no fallback: the reader keeps answering from configuration
    // only, even when the global news table is gone.
    const before = (await readOf(db, "account-a", "research")).sourceIds;
    await db.prepare("DROP TABLE poc_news").run();
    const stillEmpty = await readOf(db, "account-c", "solo");
    assert.deepEqual(stillEmpty.sourceIds, []);
    assert.deepEqual((await readOf(db, "account-a", "research")).sourceIds, before);
  });
});

test("real D1: business reads never write configuration, scheduling fields or news", async () => {
  await withD1(async db => {
    await seed(db);
    const before = await snapshot(db);
    const reader = createD1SubscriptionReader(db);

    await reader.read(subjectFromPrincipal(principal("account-a", "research")));
    await reader.read(subjectFromPrincipal(principal("account-a", "radar")));
    await reader.read(subjectFromPrincipal(principal("account-b", "radar")));
    await reader.read(subjectFromPrincipal(principal("account-c", "solo")));
    await reader.read(subjectFromPrincipal(principal("account-a", "missing")));
    await reader.read(subjectFromPrincipal(principal("missing", "research")));

    assert.deepEqual(await snapshot(db), before);
    // The account/consumer interval preference never rewrites the scheduler.
    assert.deepEqual(
      (await rows(db, "SELECT interval_hours,due_at,last_checked_at,lease_token FROM poc_sources WHERE id='shared'"))[0],
      { interval_hours: 1, due_at: stamp, last_checked_at: null, lease_token: null },
    );
  });
});

test("real D1: removing one consumer's private subscription leaves the shared baseline and siblings intact", async () => {
  await withD1(async db => {
    await seed(db);
    const accountSubsBefore = await rows(db,
      "SELECT * FROM guanlan_account_subscriptions ORDER BY account_id,source_id");
    const sourcesBefore = await rows(db, "SELECT * FROM poc_sources ORDER BY id");

    // Drop only account-a/research private increments.
    await insert(db,
      "DELETE FROM guanlan_consumer_subscriptions WHERE account_id=? AND consumer_id=?",
      "account-a", "research");

    const research = await readOf(db, "account-a", "research");
    assert.deepEqual(research.sourceIds, ["account-only", "pref-high", "shared"]);
    assert.deepEqual(research.sources.map(s => [s.sourceId, s.intervalHours, s.intervalSource]), [
      ["account-only", 2, "account"],
      // The account baseline interval returns once the private row is gone.
      ["pref-high", 2, "account"],
      ["shared", 4, "account"],
    ]);
    // Consumer interests are a separate configuration set: deleting private
    // subscriptions must not silently rewrite them.
    assert.deepEqual(research.interests.map(i => [i.kind, i.value, i.origin]), [
      ["keyword", "Science", "both"],
      ["topic", "Robotics", "consumer"],
      ["topic", "Space", "account"],
    ]);

    // Sibling consumer and the other account are untouched.
    assert.deepEqual((await readOf(db, "account-a", "radar")).sourceIds,
      ["account-only", "pref-high", "shared"]);
    assert.deepEqual((await readOf(db, "account-b", "radar")).sourceIds, ["other-only", "shared"]);
    assert.deepEqual(await rows(db,
      "SELECT * FROM guanlan_account_subscriptions ORDER BY account_id,source_id"), accountSubsBefore);

    // Removing an account baseline row removes it for every consumer of that
    // account only; the other account keeps its own configuration.
    await insert(db,
      "DELETE FROM guanlan_account_subscriptions WHERE account_id=? AND source_id=?",
      "account-a", "account-only");
    assert.deepEqual((await readOf(db, "account-a", "research")).sourceIds, ["pref-high", "shared"]);
    assert.deepEqual((await readOf(db, "account-a", "radar")).sourceIds, ["pref-high", "shared"]);
    assert.deepEqual((await readOf(db, "account-b", "radar")).sourceIds, ["other-only", "shared"]);

    // Shared source rows (public ingestion state) were never rewritten.
    assert.deepEqual(await rows(db, "SELECT * FROM poc_sources ORDER BY id"), sourcesBefore);
    assert.deepEqual(await rows(db, "PRAGMA foreign_key_check"), []);
  });
});

test("real D1: a missing domain table is an explicit storage failure, not empty success", async () => {
  await withD1(async db => {
    await seed(db);
    // workerd/D1 rejects the batch instead of returning success:false, so this
    // proves the real failure path, not just the defensive branch.
    await db.prepare("DROP TABLE guanlan_consumer_interests").run();
    await assert.rejects(
      createD1SubscriptionReader(db).read(subjectFromPrincipal(principal("account-a", "research"))),
      error => error instanceof SubscriptionReadError && error.code === "storage_failure",
    );
    // A known account with no readable configuration must not become an
    // empty-but-successful answer either.
    await db.prepare("DROP TABLE guanlan_accounts").run();
    await assert.rejects(
      createD1SubscriptionReader(db).read(subjectFromPrincipal(principal("account-a", "research"))),
      error => error instanceof SubscriptionReadError && error.code === "storage_failure",
    );
  });
});
