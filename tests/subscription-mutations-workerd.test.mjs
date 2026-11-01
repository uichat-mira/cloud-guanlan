import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import {
  SubscriptionMutationError,
  createD1SubscriptionMutator,
  managementGrantFromPrincipal,
} from "../dist/subscription-mutations-unit.mjs";
import { createD1SourceRegistry } from "../dist/source-registry.mjs";
import {
  createD1SubscriptionReader,
  subjectFromPrincipal,
} from "../dist/subscriptions-unit.mjs";

// GLN-011 T3: the mutation domain port runs against a real workerd/D1 database.
// The effective view is always produced by the unchanged GLN-006 reader, never
// by a second merge implementation in this test or in the port.
const MIGRATIONS = [
  "migrations/0001_poc.sql",
  "migrations/0002_source_leases.sql",
  "migrations/0003_guanlan_accounts.sql",
  "migrations/0004_consumer_news_state.sql",
];
const APPROVED = "https://developers.cloudflare.com/changelog/rss/index.xml";
const APPROVED_2 = "https://hnrss.org/newest?count=5";
const APPROVED_3 = "https://www.cloudflarestatus.com/history.atom";
const UNAPPROVED = "https://example.com/legacy.xml";
const stamp = "2026-11-01T00:00:00.000Z";

async function withD1(fn) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: "dist/worker.mjs",
    compatibilityDate: "2026-08-06",
    cf: false,
    d1Databases: { DB: "00000000-0000-4000-8000-000000000111" },
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
const grantOf = (authority, accountId, consumerId) => {
  const authorization = managementGrantFromPrincipal(
    principal(accountId, consumerId),
    authority,
  );
  assert.equal(authorization.ok, true, JSON.stringify(authorization));
  return authorization.grant;
};
const mutate = (db, grant, input) => createD1SubscriptionMutator(db).mutate(grant, input);
const readOf = async (db, accountId, consumerId) => {
  const read = await createD1SubscriptionReader(db)
    .read(subjectFromPrincipal(principal(accountId, consumerId)));
  assert.equal(read.ok, true, `${accountId}/${consumerId} should be readable`);
  return read.effective;
};

const ORDER = {
  guanlan_accounts: "1",
  guanlan_consumers: "1,2",
  guanlan_account_interests: "1,2,3",
  guanlan_consumer_interests: "1,2,3,4",
  guanlan_consumer_news_states: "1,2,3",
  poc_sources: "1",
  poc_news: "1",
};
const INVARIANT_TABLES = Object.keys(ORDER);
async function snapshot(db) {
  const out = {};
  for (const table of INVARIANT_TABLES) {
    out[table] = await rows(db, `SELECT * FROM ${table} ORDER BY ${ORDER[table]}`);
  }
  return out;
}

const subscriptionCounts = async db => ({
  account: (await rows(db, "SELECT COUNT(*) AS n FROM guanlan_account_subscriptions"))[0].n,
  consumer: (await rows(db, "SELECT COUNT(*) AS n FROM guanlan_consumer_subscriptions"))[0].n,
});

async function seed(db) {
  const registry = createD1SourceRegistry(db);
  const first = await registry.register({ url: APPROVED, intervalHours: 1 });
  const second = await registry.register({ url: APPROVED_2, intervalHours: 2 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  await insert(db,
    "INSERT INTO poc_sources(id,url,interval_hours,due_at) VALUES(?,?,?,?)",
    "historical-unapproved", UNAPPROVED, 1, stamp);
  await insert(db,
    "INSERT INTO poc_news(url,source_id,title,summary,ingested_at) VALUES(?,?,?,?,?)",
    "https://example.com/story", first.sourceId, "Global story", "Summary", stamp);

  for (const account of ["account-a", "account-b"]) {
    await insert(db, "INSERT INTO guanlan_accounts(account_id,created_at) VALUES(?,?)", account, stamp);
  }
  for (const [account, consumer] of [
    ["account-a", "a1"], ["account-a", "a2"], ["account-b", "b1"],
    ["account-b", "shared"], ["account-a", "shared"],
  ]) {
    await insert(db,
      "INSERT INTO guanlan_consumers(account_id,consumer_id,created_at) VALUES(?,?,?)",
      account, consumer, stamp);
  }

  await insert(db,
    "INSERT INTO guanlan_account_interests(account_id,kind,value,created_at) VALUES(?,?,?,?)",
    "account-a", "keyword", "Science", stamp);
  await insert(db,
    "INSERT INTO guanlan_consumer_interests(account_id,consumer_id,kind,value,created_at) VALUES(?,?,?,?,?)",
    "account-a", "a1", "topic", "Robotics", stamp);
  await insert(db,
    `INSERT INTO guanlan_consumer_news_states(
       account_id,consumer_id,news_fingerprint,source_id,status,decided_at,version,last_operation_id
     ) VALUES(?,?,?,?,?,?,?,?)`,
    "account-a", "a1", "f".repeat(64), first.sourceId, "adopted", stamp, 1, "op-1");

  return { first, second };
}

test("real D1: account and consumer levels stay isolated across two accounts and sibling consumers", async () => {
  await withD1(async db => {
    const { first } = await seed(db);
    const sourceId = first.sourceId;
    const accountA = grantOf("account", "account-a", "a1");
    const accountB = grantOf("account", "account-b", "b1");
    const a1 = grantOf("consumer", "account-a", "a1");
    const a2 = grantOf("consumer", "account-a", "a2");
    const before = await snapshot(db);
    const schedulerBefore = (await rows(db,
      "SELECT interval_hours,due_at,last_checked_at,lease_token,lease_expires_at,retry_count FROM poc_sources WHERE id=?",
      sourceId))[0];

    // Account baseline for A; A1 and A2 inherit it, B does not.
    let result = await mutate(db, accountA, { level: "account", op: "upsert", sourceId, intervalHours: 4 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.changed, true);
    assert.deepEqual(result.effective.sources, [
      { sourceId, origin: "account", intervalHours: 4, intervalSource: "account" },
    ]);
    assert.deepEqual((await readOf(db, "account-a", "a2")).sourceIds, [sourceId]);
    assert.deepEqual((await readOf(db, "account-b", "b1")).sourceIds, []);

    // A second account reuses the same shared source with its own preference.
    result = await mutate(db, accountB, { level: "account", op: "upsert", sourceId, intervalHours: 3 });
    assert.equal(result.ok, true);
    assert.deepEqual((await readOf(db, "account-b", "b1")).sources, [
      { sourceId, origin: "account", intervalHours: 3, intervalSource: "account" },
    ]);
    assert.deepEqual((await readOf(db, "account-a", "a1")).sources, [
      { sourceId, origin: "account", intervalHours: 4, intervalSource: "account" },
    ]);

    // Consumer A1 overrides the account interval; A2 keeps the baseline.
    result = await mutate(db, a1, { level: "consumer", op: "upsert", sourceId, intervalHours: 8 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.effective.sources, [
      { sourceId, origin: "both", intervalHours: 8, intervalSource: "consumer" },
    ]);
    assert.deepEqual((await readOf(db, "account-a", "a2")).sources, [
      { sourceId, origin: "account", intervalHours: 4, intervalSource: "account" },
    ]);

    // A consumer-only increment is visible to that consumer alone.
    const second = (await rows(db, "SELECT id FROM poc_sources WHERE url=?", APPROVED_2))[0].id;
    const expectedOrder = [second, sourceId].sort();
    result = await mutate(db, a1, { level: "consumer", op: "upsert", sourceId: second, intervalHours: 2 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.effective.sourceIds, expectedOrder);
    assert.deepEqual((await readOf(db, "account-a", "a2")).sourceIds, [sourceId]);

    // A2 overrides the same shared source independently.
    result = await mutate(db, a2, { level: "consumer", op: "upsert", sourceId, intervalHours: 1 });
    assert.equal(result.ok, true);
    assert.deepEqual(
      (await readOf(db, "account-a", "a1")).sources
        .map(source => [source.sourceId, source.origin, source.intervalHours, source.intervalSource])
        .sort(),
      [
        [second, "consumer", 2, "consumer"],
        [sourceId, "both", 8, "consumer"],
      ].sort(),
    );
    assert.deepEqual((await readOf(db, "account-a", "a2")).sources, [
      { sourceId, origin: "both", intervalHours: 1, intervalSource: "consumer" },
    ]);

    // Removing the A1 override restores the account baseline for A1 only.
    result = await mutate(db, a1, { level: "consumer", op: "remove", sourceId });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.deepEqual(
      result.effective.sources
        .map(source => [source.sourceId, source.origin, source.intervalHours, source.intervalSource])
        .sort(),
      [
        [second, "consumer", 2, "consumer"],
        [sourceId, "account", 4, "account"],
      ].sort(),
    );
    assert.deepEqual((await readOf(db, "account-a", "a2")).sources, [
      { sourceId, origin: "both", intervalHours: 1, intervalSource: "consumer" },
    ]);

    // Removing the account baseline keeps an existing consumer override.
    result = await mutate(db, accountA, { level: "account", op: "remove", sourceId });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.deepEqual(result.effective.sourceIds, [second]);
    // A2's private override still covers the shared source.
    assert.deepEqual((await readOf(db, "account-a", "a2")).sources, [
      { sourceId, origin: "consumer", intervalHours: 1, intervalSource: "consumer" },
    ]);
    // The other account is untouched.
    assert.deepEqual((await readOf(db, "account-b", "b1")).sourceIds, [sourceId]);

    // Every non-subscription table is byte-for-byte unchanged: the shared
    // collection catalog, news, interests, decisions, accounts and consumers.
    assert.deepEqual(await snapshot(db), before);
    assert.deepEqual(await rows(db, "PRAGMA foreign_key_check"), []);
    // The preference never rewrote the shared scheduler fields.
    const scheduler = (await rows(db,
      "SELECT interval_hours,due_at,last_checked_at,lease_token,lease_expires_at,retry_count FROM poc_sources WHERE id=?",
      sourceId))[0];
    assert.deepEqual(scheduler, schedulerBefore);
    assert.equal(scheduler.interval_hours, 1);
    assert.equal(scheduler.last_checked_at, null);
    assert.equal(scheduler.lease_token, null);
    assert.equal(scheduler.lease_expires_at, null);
    assert.equal(scheduler.retry_count, 0);
  });
});

test("real D1: repeated upserts and removes are idempotent, including under concurrency", async () => {
  await withD1(async db => {
    const { first } = await seed(db);
    const sourceId = first.sourceId;
    const grant = grantOf("account", "account-a", "a1");

    const created = await mutate(db, grant, { level: "account", op: "upsert", sourceId, intervalHours: 4 });
    assert.equal(created.ok, true);
    assert.equal(created.changed, true);
    const createdAt = (await rows(db,
      "SELECT created_at FROM guanlan_account_subscriptions WHERE account_id=? AND source_id=?",
      "account-a", sourceId))[0].created_at;

    const same = await mutate(db, grant, { level: "account", op: "upsert", sourceId, intervalHours: 4 });
    assert.equal(same.ok, true);
    assert.equal(same.changed, false);
    assert.equal((await rows(db,
      "SELECT created_at FROM guanlan_account_subscriptions WHERE account_id=? AND source_id=?",
      "account-a", sourceId))[0].created_at, createdAt);

    const removed = await mutate(db, grant, { level: "account", op: "remove", sourceId });
    assert.equal(removed.ok, true);
    assert.equal(removed.changed, true);
    const removedAgain = await mutate(db, grant, { level: "account", op: "remove", sourceId });
    assert.equal(removedAgain.ok, true);
    assert.equal(removedAgain.changed, false);

    // Five concurrent identical upserts: exactly one changes the state, and
    // the primary key still holds one row.
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () =>
        mutate(db, grant, { level: "account", op: "upsert", sourceId, intervalHours: 6 })),
    );
    assert.equal(concurrent.every(entry => entry.ok), true, JSON.stringify(concurrent));
    assert.equal(concurrent.filter(entry => entry.changed).length, 1);
    assert.equal((await rows(db,
      "SELECT COUNT(*) AS n FROM guanlan_account_subscriptions WHERE account_id=? AND source_id=?",
      "account-a", sourceId))[0].n, 1);
    assert.deepEqual((await readOf(db, "account-a", "a1")).sources, [
      { sourceId, origin: "account", intervalHours: 6, intervalSource: "account" },
    ]);

    // Five concurrent removes: exactly one deletes the row, no duplicate or
    // resurrected row appears.
    const removals = await Promise.all(
      Array.from({ length: 5 }, () =>
        mutate(db, grant, { level: "account", op: "remove", sourceId })),
    );
    assert.equal(removals.every(entry => entry.ok), true, JSON.stringify(removals));
    assert.equal(removals.filter(entry => entry.changed).length, 1);
    assert.deepEqual((await readOf(db, "account-a", "a1")).sourceIds, []);
    assert.equal((await subscriptionCounts(db)).account, 0);
    assert.deepEqual(await rows(db, "PRAGMA foreign_key_check"), []);
  });
});

test("real D1: unknown, unapproved and tampered sources are refused without writing", async () => {
  await withD1(async db => {
    const { second } = await seed(db);
    const grant = grantOf("account", "account-a", "a1");

    assert.deepEqual(
      await mutate(db, grant, { level: "account", op: "upsert", sourceId: "does-not-exist", intervalHours: 1 }),
      { ok: false, failure: "source_not_found" },
    );
    assert.deepEqual(
      await mutate(db, grant, { level: "account", op: "upsert", sourceId: "historical-unapproved", intervalHours: 1 }),
      { ok: false, failure: "source_not_approved" },
    );
    assert.deepEqual(await subscriptionCounts(db), { account: 0, consumer: 0 });

    // The stored URL, not the id, is the admission authority. Tampering an
    // approved source row makes the same id unusable; a manual row whose URL is
    // exactly approved is a legitimate source.
    await db.prepare("UPDATE poc_sources SET url=? WHERE id=?").bind(UNAPPROVED + "?tampered", second.sourceId).run();
    assert.deepEqual(
      await mutate(db, grant, { level: "account", op: "upsert", sourceId: second.sourceId, intervalHours: 2 }),
      { ok: false, failure: "source_not_approved" },
    );

    // `poc_sources.id` has no 128-character account-id bound; a long stored id
    // with an exactly-approved URL stays usable end to end.
    const longId = "s".repeat(129);
    await insert(db,
      "INSERT INTO poc_sources(id,url,interval_hours,due_at) VALUES(?,?,?,?)",
      longId, APPROVED_3, 1, stamp);
    const accepted = await mutate(db, grant, {
      level: "account", op: "upsert", sourceId: longId, intervalHours: 2,
    });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(accepted.sourceId, longId);
    assert.deepEqual(accepted.effective.sources, [
      { sourceId: longId, origin: "account", intervalHours: 2, intervalSource: "account" },
    ]);
    assert.deepEqual(await rows(db, "PRAGMA foreign_key_check"), []);
  });
});

test("real D1: management authority is enforced and cannot be smuggled through the DTO", async () => {
  await withD1(async db => {
    const { first } = await seed(db);
    const sourceId = first.sourceId;
    const before = await subscriptionCounts(db);

    // A consumer manager cannot edit the shared account baseline.
    assert.deepEqual(
      await mutate(db, grantOf("consumer", "account-a", "a1"),
        { level: "account", op: "upsert", sourceId, intervalHours: 1 }),
      { ok: false, failure: "forbidden" },
    );
    // An account manager cannot edit a consumer's private increment.
    assert.deepEqual(
      await mutate(db, grantOf("account", "account-a", "a1"),
        { level: "consumer", op: "upsert", sourceId, intervalHours: 1 }),
      { ok: false, failure: "forbidden" },
    );
    // A read-only subject is not a management grant.
    assert.deepEqual(
      await mutate(db, subjectFromPrincipal(principal("account-a", "a1")),
        { level: "account", op: "upsert", sourceId, intervalHours: 1 }),
      { ok: false, failure: "forbidden" },
    );
    assert.deepEqual(await subscriptionCounts(db), before);

    // Identity fields in the DTO are ignored: the grant's account/consumer win.
    const smuggledAccount = await mutate(db, grantOf("account", "account-a", "a1"), {
      level: "account", op: "upsert", sourceId, intervalHours: 2,
      accountId: "account-b", consumerId: "b1",
    });
    assert.equal(smuggledAccount.ok, true);
    assert.equal((await rows(db,
      "SELECT COUNT(*) AS n FROM guanlan_account_subscriptions WHERE account_id='account-b'"))[0].n, 0);
    assert.equal((await rows(db,
      "SELECT COUNT(*) AS n FROM guanlan_account_subscriptions WHERE account_id='account-a'"))[0].n, 1);

    // Same consumer label under another account is a different tenant.
    const smuggledConsumer = await mutate(db, grantOf("consumer", "account-a", "a1"), {
      level: "consumer", op: "upsert", sourceId, intervalHours: 3,
      consumerId: "shared",
    });
    assert.equal(smuggledConsumer.ok, true);
    assert.equal((await rows(db,
      "SELECT COUNT(*) AS n FROM guanlan_consumer_subscriptions WHERE consumer_id='shared'"))[0].n, 0);
    assert.equal((await rows(db,
      "SELECT COUNT(*) AS n FROM guanlan_consumer_subscriptions WHERE consumer_id='a1'"))[0].n, 1);

    // Missing subjects are explicit denials and produce no rows.
    assert.deepEqual(
      await mutate(db, grantOf("account", "ghost-account", "a1"),
        { level: "account", op: "upsert", sourceId, intervalHours: 1 }),
      { ok: false, failure: "account_not_found" },
    );
    assert.deepEqual(
      await mutate(db, grantOf("account", "account-a", "ghost-consumer"),
        { level: "account", op: "upsert", sourceId, intervalHours: 1 }),
      { ok: false, failure: "consumer_not_found" },
    );
    assert.deepEqual(await rows(db, "PRAGMA foreign_key_check"), []);
  });
});

test("real D1: a broken subscription table is a storage failure with no partial write", async () => {
  await withD1(async db => {
    const { first } = await seed(db);
    const sourceId = first.sourceId;
    const grant = grantOf("account", "account-a", "a1");

    await db.prepare("DROP TABLE guanlan_account_subscriptions").run();
    await assert.rejects(
      mutate(db, grant, { level: "account", op: "upsert", sourceId, intervalHours: 4 }),
      error => error instanceof SubscriptionMutationError && error.code === "storage_failure",
    );
    // The consumer table and every shared table are untouched by the failed
    // account-level write.
    assert.equal((await rows(db, "SELECT COUNT(*) AS n FROM guanlan_consumer_subscriptions"))[0].n, 0);
    assert.equal((await rows(db, "SELECT COUNT(*) AS n FROM poc_sources"))[0].n, 3);
    assert.equal((await rows(db, "SELECT COUNT(*) AS n FROM poc_news"))[0].n, 1);
    assert.equal((await rows(db, "SELECT COUNT(*) AS n FROM guanlan_consumer_news_states"))[0].n, 1);
    assert.deepEqual(await rows(db, "PRAGMA foreign_key_check"), []);
  });
});

test("real D1: an account baseline removal never deletes a sibling consumer's override or shared data", async () => {
  await withD1(async db => {
    const { first } = await seed(db);
    const sourceId = first.sourceId;
    const before = await snapshot(db);

    await mutate(db, grantOf("account", "account-a", "a1"),
      { level: "account", op: "upsert", sourceId, intervalHours: 4 });
    await mutate(db, grantOf("consumer", "account-a", "a2"),
      { level: "consumer", op: "upsert", sourceId, intervalHours: 2 });
    const afterWrites = await snapshot(db);
    // Only the two subscription tables may differ from the seed.
    assert.deepEqual(afterWrites, before);

    const removed = await mutate(db, grantOf("account", "account-a", "a1"),
      { level: "account", op: "remove", sourceId });
    assert.equal(removed.ok, true);
    assert.deepEqual(removed.effective.sourceIds, []);
    // A2's private row survived the account baseline removal.
    assert.deepEqual((await readOf(db, "account-a", "a2")).sources, [
      { sourceId, origin: "consumer", intervalHours: 2, intervalSource: "consumer" },
    ]);
    assert.deepEqual(await snapshot(db), before);
    assert.deepEqual(await rows(db, "PRAGMA foreign_key_check"), []);
  });
});
