import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import {
  ConsumptionLedgerError,
  createD1ConsumptionLedger,
  fingerprintForCanonicalUrl,
} from "../dist/consumption-unit.mjs";
import {
  createD1SubscriptionReader,
  subjectFromPrincipal,
} from "../dist/subscriptions-unit.mjs";

// GLN-007 T3: the ledger runs against a real workerd/D1 database, never an
// in-memory Node SQLite mock. Miniflare owns the database and its constraints;
// the ledger and the GLN-006 reader are the same modules the Worker imports.
const MIGRATIONS = [
  "migrations/0001_poc.sql",
  "migrations/0002_source_leases.sql",
  "migrations/0003_guanlan_accounts.sql",
  "migrations/0004_consumer_news_state.sql",
];
const stamp = "2026-11-01T00:00:00.000Z";
const NEWS = {
  shared1: "https://example.com/story/1",
  shared2: "https://example.com/story/2",
  private1: "https://example.com/private/1",
  other1: "https://example.com/other/1",
};

async function withD1(fn) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: "dist/worker.mjs",
    compatibilityDate: "2026-08-06",
    cf: false,
    d1Databases: { DB: "00000000-0000-4000-8000-000000000014" },
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
  scopes: ["guanlan.read", "guanlan.write"],
  expiresAt: 4_102_444_800,
  issuer: "mira:cloud-auth",
  audience: "mira:cloud-guanlan",
});
const subject = (accountId, consumerId) =>
  subjectFromPrincipal(principal(accountId, consumerId));

/** Deterministic clock whose value can be advanced between requests. */
const clock = (start = stamp) => {
  let current = Date.parse(start);
  const now = () => new Date(current);
  now.advance = milliseconds => { current += milliseconds; };
  return now;
};

/** A fresh ledger instance over the same database, as after a process restart. */
const ledgerFor = (db, now = clock()) => createD1ConsumptionLedger({
  db,
  subscriptions: createD1SubscriptionReader(db),
  now,
});

async function seed(db) {
  for (const [id, url] of [
    ["shared", "https://example.com/shared.xml"],
    ["private", "https://example.com/private.xml"],
    ["other", "https://example.com/other.xml"],
  ]) {
    await insert(db, "INSERT INTO poc_sources(id,url,interval_hours,due_at) VALUES(?,?,?,?)",
      id, url, 1, stamp);
  }
  // Same title on purpose: identity must come from the URL, never the title.
  for (const [url, source] of [
    [NEWS.shared1, "shared"],
    [NEWS.shared2, "shared"],
    // Query-string variants are separate collected articles, so they must be
    // separate decision identities too.
    [`${NEWS.shared1}?utm_source=feed`, "shared"],
    [NEWS.private1, "private"],
    [NEWS.other1, "other"],
  ]) {
    await insert(db,
      "INSERT INTO poc_news(url,source_id,title,summary,ingested_at) VALUES(?,?,?,?,?)",
      url, source, "Identical headline", "Summary", stamp);
  }
  for (const account of ["account-a", "account-b"]) {
    await insert(db, "INSERT INTO guanlan_accounts(account_id,created_at) VALUES(?,?)", account, stamp);
  }
  for (const [account, consumer] of [
    ["account-a", "research"], ["account-a", "radar"], ["account-b", "radar"],
  ]) {
    await insert(db, "INSERT INTO guanlan_consumers(account_id,consumer_id,created_at) VALUES(?,?,?)",
      account, consumer, stamp);
  }
  // `shared` is subscribed by both accounts at account level, so account B can
  // legitimately read the same URL and must still see its own `unread`.
  await insert(db,
    "INSERT INTO guanlan_account_subscriptions(account_id,source_id,created_at) VALUES(?,?,?)",
    "account-a", "shared", stamp);
  await insert(db,
    "INSERT INTO guanlan_account_subscriptions(account_id,source_id,created_at) VALUES(?,?,?)",
    "account-b", "shared", stamp);
  // A consumer-specific increment: only account-a/research may see it.
  await insert(db,
    "INSERT INTO guanlan_consumer_subscriptions(account_id,consumer_id,source_id,created_at) VALUES(?,?,?,?)",
    "account-a", "research", "private", stamp);
}

const write = (db, identity, request, now) => ledgerFor(db, now).write(subject(...identity), request);
const read = (db, identity, urls, now) => ledgerFor(db, now).read(subject(...identity), { urls });

const TABLES = [
  "guanlan_accounts",
  "guanlan_consumers",
  "guanlan_account_subscriptions",
  "guanlan_consumer_subscriptions",
  "guanlan_account_interests",
  "guanlan_consumer_interests",
  "guanlan_consumer_news_states",
  "poc_sources",
  "poc_news",
];
async function snapshot(db) {
  const out = {};
  for (const table of TABLES) out[table] = await rows(db, `SELECT * FROM ${table} ORDER BY 1,2`);
  return out;
}

test("real D1: two consumers of one account decide the same URL differently; another account stays unread", async () => {
  await withD1(async db => {
    await seed(db);
    const pending = await write(db, ["account-a", "research"], {
      url: NEWS.shared1, status: "pending", expectedVersion: 0, operationId: "op-research-1",
    });
    assert.equal(pending.ok, true);
    assert.equal(pending.result, "updated");
    assert.deepEqual(
      [pending.state.status, pending.state.version, pending.state.sourceId],
      ["pending", 1, "shared"],
    );

    const adopted = await write(db, ["account-a", "radar"], {
      url: NEWS.shared1, status: "adopted", expectedVersion: 0, operationId: "op-radar-1",
      reason: "used for the weekly brief", outcomeUrl: "https://example.com/brief/7",
    });
    assert.equal(adopted.ok, true);
    assert.equal(adopted.state.version, 1);

    const research = await read(db, ["account-a", "research"], [NEWS.shared1]);
    const radar = await read(db, ["account-a", "radar"], [NEWS.shared1]);
    const otherAccount = await read(db, ["account-b", "radar"], [NEWS.shared1]);
    assert.deepEqual(research.states.map(state => [state.status, state.version]), [["pending", 1]]);
    assert.deepEqual(radar.states.map(state => [state.status, state.version]), [["adopted", 1]]);
    // Account B may read the same public source but never inherits A's decision.
    assert.deepEqual(
      otherAccount.states.map(state => [state.status, state.version, state.reason, state.decidedAt]),
      [["unread", 0, null, null]],
    );
    assert.equal((await rows(db, "SELECT COUNT(*) AS n FROM guanlan_consumer_news_states"))[0].n, 2);
    assert.deepEqual(await rows(db, "PRAGMA foreign_key_check"), []);
  });
});

test("real D1: unknown owner, cross-account consumer, unauthorized source and unknown news are explicit denials", async () => {
  await withD1(async db => {
    await seed(db);
    const request = (url = NEWS.shared1) => ({
      url, status: "adopted", expectedVersion: 0, operationId: "op-deny",
    });

    assert.deepEqual(
      await ledgerFor(db).read(subjectFromPrincipal({ ...principal("missing", "research") }), { urls: [NEWS.shared1] }),
      { ok: false, failure: "account_not_found" },
    );
    // `research` exists only under account-a; naming it under account-b must not
    // borrow account-a's consumer or configuration.
    assert.deepEqual(await write(db, ["account-b", "research"], request()), {
      ok: false, failure: "consumer_not_found",
    });
    // `private` is a consumer-only increment of account-a/research.
    assert.deepEqual(await read(db, ["account-a", "radar"], [NEWS.private1]), {
      ok: false, failure: "source_not_authorized",
    });
    // `other` is collected globally but subscribed by nobody.
    assert.deepEqual(await write(db, ["account-a", "research"], request(NEWS.other1)), {
      ok: false, failure: "source_not_authorized",
    });
    assert.deepEqual(await read(db, ["account-a", "research"], [NEWS.other1]), {
      ok: false, failure: "source_not_authorized",
    });
    // A URL that is not a news identity at all is not silently `unread`.
    assert.deepEqual(await read(db, ["account-a", "research"], ["https://example.com/never-collected"]), {
      ok: false, failure: "news_not_found",
    });
    assert.deepEqual(await write(db, ["account-a", "research"], request("https://example.com/never-collected")), {
      ok: false, failure: "news_not_found",
    });
    // A batch is atomic: one unauthorized URL fails the whole read explicitly.
    assert.deepEqual(await read(db, ["account-a", "research"], [NEWS.shared1, NEWS.other1]), {
      ok: false, failure: "source_not_authorized",
    });
    assert.equal((await rows(db, "SELECT COUNT(*) AS n FROM guanlan_consumer_news_states"))[0].n, 0);
  });
});

test("real D1: reading an implied unread writes nothing", async () => {
  await withD1(async db => {
    await seed(db);
    const before = await snapshot(db);
    const first = await read(db, ["account-a", "research"], [NEWS.shared1, NEWS.shared2, NEWS.private1]);
    assert.equal(first.ok, true);
    assert.deepEqual(first.states.map(state => state.status), ["unread", "unread", "unread"]);
    assert.deepEqual(first.states.map(state => state.version), [0, 0, 0]);
    // Re-reading, reading another consumer and a failing read all stay side-effect free.
    await read(db, ["account-a", "radar"], [NEWS.shared1]);
    await read(db, ["account-b", "radar"], [NEWS.shared1]);
    await read(db, ["account-a", "research"], [NEWS.other1]);
    assert.deepEqual(await snapshot(db), before);
    assert.equal((await rows(db, "SELECT COUNT(*) AS n FROM guanlan_consumer_news_states"))[0].n, 0);
  });
});

test("real D1: unread can move straight to adopted or ignored without a pending step", async () => {
  await withD1(async db => {
    await seed(db);
    const adopted = await write(db, ["account-a", "research"], {
      url: NEWS.shared1, status: "adopted", expectedVersion: 0, operationId: "op-direct-adopted",
    });
    const ignored = await write(db, ["account-a", "research"], {
      url: NEWS.shared2, status: "ignored", expectedVersion: 0, operationId: "op-direct-ignored",
      reason: "duplicate of story 1",
    });
    assert.equal(adopted.ok, true);
    assert.equal(ignored.ok, true);
    assert.deepEqual([adopted.state.status, adopted.state.version], ["adopted", 1]);
    assert.deepEqual([ignored.state.status, ignored.state.version, ignored.state.reason],
      ["ignored", 1, "duplicate of story 1"]);

    const states = await read(db, ["account-a", "research"], [NEWS.shared1, NEWS.shared2]);
    assert.deepEqual(states.states.map(state => [state.status, state.version]),
      [["adopted", 1], ["ignored", 1]]);
  });
});

test("real D1: an exact retry replays without a new row, version or timestamp", async () => {
  await withD1(async db => {
    await seed(db);
    const now = clock();
    const request = {
      url: NEWS.shared1, status: "adopted", expectedVersion: 0, operationId: "op-retry",
      reason: "accepted", outcomeUrl: "https://example.com/report",
    };
    const first = await ledgerFor(db, now).write(subject("account-a", "research"), request);
    assert.equal(first.ok, true);
    assert.equal(first.result, "updated");
    const decidedAt = first.state.decidedAt;

    now.advance(60_000);
    // Same request from another request/device, with the original precondition.
    const retry = await ledgerFor(db, now).write(subject("account-a", "research"), request);
    assert.equal(retry.ok, true);
    assert.equal(retry.result, "replayed");
    assert.deepEqual(retry.state, first.state);
    // Replaying with a freshly re-read version must not bump the version either.
    const retryWithVersion = await ledgerFor(db, now).write(subject("account-a", "research"), {
      ...request, expectedVersion: 1,
    });
    assert.equal(retryWithVersion.ok, true);
    assert.equal(retryWithVersion.result, "replayed");
    assert.equal(retryWithVersion.state.version, 1);
    assert.equal(retryWithVersion.state.decidedAt, decidedAt);

    // Same operation id, different decision: refused, nothing changes.
    const conflicting = await ledgerFor(db, now).write(subject("account-a", "research"), {
      ...request, status: "ignored", expectedVersion: 1,
    });
    assert.equal(conflicting.ok, false);
    assert.equal(conflicting.failure, "operation_conflict");
    assert.deepEqual([conflicting.current.status, conflicting.current.version], ["adopted", 1]);

    const stored = await rows(db, "SELECT * FROM guanlan_consumer_news_states");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].decided_at, decidedAt);
    assert.equal(stored[0].version, 1);

    // A genuinely new decision needs a new operation id and bumps the version.
    const next = await ledgerFor(db, now).write(subject("account-a", "research"), {
      ...request, status: "ignored", expectedVersion: 1, operationId: "op-next",
    });
    assert.equal(next.ok, true);
    assert.equal(next.result, "updated");
    assert.equal(next.state.version, 2);
    assert.notEqual(next.state.decidedAt, decidedAt);
  });
});

test("real D1: nonzero expectedVersion cannot create a missing ledger row", async () => {
  await withD1(async db => {
    await seed(db);
    const identity = ["account-a", "research"];
    const fingerprint = await fingerprintForCanonicalUrl(NEWS.shared1);

    const stale = await write(db, identity, {
      url: NEWS.shared1, status: "adopted", expectedVersion: 7, operationId: "op-absent-stale",
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.failure, "version_conflict");
    assert.deepEqual([stale.current.status, stale.current.version], ["unread", 0]);
    assert.deepEqual(
      await rows(db, "SELECT version FROM guanlan_consumer_news_states WHERE news_fingerprint=?", fingerprint),
      [],
      "the wrong precondition must never create a decision",
    );

    const first = await write(db, identity, {
      url: NEWS.shared1, status: "adopted", expectedVersion: 0, operationId: "op-absent-first",
    });
    assert.equal(first.ok, true);
    assert.equal(first.result, "updated");
    assert.equal(first.state.version, 1);

    const outdated = await write(db, identity, {
      url: NEWS.shared1, status: "ignored", expectedVersion: 7, operationId: "op-absent-later",
    });
    assert.equal(outdated.ok, false);
    assert.equal(outdated.failure, "version_conflict");
    assert.equal(outdated.current.version, 1);
    assert.deepEqual(
      await rows(db, "SELECT status,version FROM guanlan_consumer_news_states WHERE news_fingerprint=?", fingerprint),
      [{ status: "adopted", version: 1 }],
    );
  });
});

test("real D1: stale and concurrent operations cannot overwrite a newer decision", async () => {
  await withD1(async db => {
    await seed(db);
    const now = clock();
    const first = await write(db, ["account-a", "research"], {
      url: NEWS.shared1, status: "adopted", expectedVersion: 0, operationId: "op-1",
    });
    assert.equal(first.ok, true);
    const second = await write(db, ["account-a", "research"], {
      url: NEWS.shared1, status: "ignored", expectedVersion: 1, operationId: "op-2",
    });
    assert.equal(second.ok, true);
    assert.equal(second.state.version, 2);

    // A delayed older decision arrives after the newer one: it must lose.
    const delayed = await write(db, ["account-a", "research"], {
      url: NEWS.shared1, status: "pending", expectedVersion: 0, operationId: "op-late",
    });
    assert.equal(delayed.ok, false);
    assert.equal(delayed.failure, "version_conflict");
    assert.deepEqual([delayed.current.status, delayed.current.version], ["ignored", 2]);
    const afterDelay = await read(db, ["account-a", "research"], [NEWS.shared1]);
    assert.deepEqual(afterDelay.states.map(state => [state.status, state.version]), [["ignored", 2]]);

    // Two conflicting operations racing from `unread`: the database must settle
    // on exactly one decision, and the loser must be told the truth.
    const [left, right] = await Promise.all([
      write(db, ["account-a", "research"], {
        url: NEWS.shared2, status: "adopted", expectedVersion: 0, operationId: "op-race-a",
      }),
      write(db, ["account-a", "research"], {
        url: NEWS.shared2, status: "ignored", expectedVersion: 0, operationId: "op-race-b",
      }),
    ]);
    const winners = [left, right].filter(result => result.ok);
    const losers = [left, right].filter(result => !result.ok);
    assert.equal(winners.length, 1, "exactly one concurrent decision may win");
    assert.equal(losers.length, 1);
    assert.equal(losers[0].failure, "version_conflict");
    assert.equal(losers[0].current.version, 1);
    const raced = await rows(db,
      "SELECT status, version FROM guanlan_consumer_news_states WHERE news_fingerprint = ?",
      await fingerprintForCanonicalUrl(NEWS.shared2));
    assert.equal(raced.length, 1);
    assert.deepEqual([raced[0].version], [1]);
    assert.equal(raced[0].status, winners[0].state.status);

    // A retry after a lost response still replays across a fresh process.
    const winner = winners[0];
    const winningOperationId = winner.state.status === "adopted" ? "op-race-a" : "op-race-b";
    const replay = await ledgerFor(db, now).write(subject("account-a", "research"), {
      url: NEWS.shared2,
      status: winner.state.status,
      expectedVersion: 0,
      operationId: winningOperationId,
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.result, "replayed");
    assert.equal(replay.state.version, 1);
  });
});

test("real D1: a decision survives a news-index purge and re-collection, without bypassing permission", async () => {
  await withD1(async db => {
    await seed(db);
    const now = clock();
    const adopted = await write(db, ["account-a", "research"], {
      url: NEWS.shared1, status: "adopted", expectedVersion: 0, operationId: "op-purge",
      reason: "keep",
    });
    assert.equal(adopted.ok, true);

    // Simulate the 90-day news-index cleanup: only the shared index row goes.
    await insert(db, "DELETE FROM poc_news WHERE url = ?", NEWS.shared1);
    assert.equal((await rows(db, "SELECT COUNT(*) AS n FROM poc_news WHERE url = ?", NEWS.shared1))[0].n, 0);
    const remembered = await read(db, ["account-a", "research"], [NEWS.shared1]);
    assert.equal(remembered.ok, true);
    assert.deepEqual(
      [remembered.states[0].status, remembered.states[0].version, remembered.states[0].sourceId],
      ["adopted", 1, "shared"],
    );
    // No new decision may be written while the article is not in the index.
    const writeWhilePurged = await write(db, ["account-a", "research"], {
      url: NEWS.shared1, status: "ignored", expectedVersion: 1, operationId: "op-while-purged",
    });
    assert.deepEqual(writeWhilePurged, { ok: false, failure: "news_not_found" });

    // Re-collection of the same canonical URL restores the same identity.
    await insert(db,
      "INSERT INTO poc_news(url,source_id,title,summary,ingested_at) VALUES(?,?,?,?,?)",
      NEWS.shared1, "shared", "Identical headline", "Summary", stamp);
    const afterRecollect = await read(db, ["account-a", "research"], [NEWS.shared1]);
    assert.deepEqual([afterRecollect.states[0].status, afterRecollect.states[0].version], ["adopted", 1]);
    // And the decision may be updated again now that the article exists.
    const updated = await write(db, ["account-a", "research"], {
      url: NEWS.shared1, status: "ignored", expectedVersion: 1, operationId: "op-after-recollect",
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.state.version, 2);

    // Purging the index must never delete the ledger row.
    assert.equal((await rows(db, "SELECT COUNT(*) AS n FROM guanlan_consumer_news_states"))[0].n, 1);

    // A historical fingerprint cannot bypass the current source permission:
    // once the consumer loses the source, the memory is denied, not served.
    await insert(db,
      "DELETE FROM guanlan_account_subscriptions WHERE account_id = ? AND source_id = ?",
      "account-a", "shared");
    assert.deepEqual(await read(db, ["account-a", "research"], [NEWS.shared1]), {
      ok: false, failure: "source_not_authorized",
    });
    // A write against the now-unsubscribed source is denied even though the
    // news row still exists and the caller holds the current version.
    assert.deepEqual(await write(db, ["account-a", "research"], {
      url: NEWS.shared1, status: "adopted", expectedVersion: 2, operationId: "op-unsubscribed",
    }), { ok: false, failure: "source_not_authorized" });

    // Purging the index afterwards keeps the same explicit denial for a read
    // (the ledger row exists but its source is no longer authorized) and turns a
    // write into `news_not_found`, because a write always needs the article.
    await insert(db, "DELETE FROM poc_news WHERE url = ?", NEWS.shared1);
    assert.deepEqual(await read(db, ["account-a", "research"], [NEWS.shared1]), {
      ok: false, failure: "source_not_authorized",
    });
    assert.deepEqual(await write(db, ["account-a", "research"], {
      url: NEWS.shared1, status: "adopted", expectedVersion: 2, operationId: "op-purged-unsubscribed",
    }), { ok: false, failure: "news_not_found" });
  });
});

test("real D1: similar titles never share a decision; URL identity is exact", async () => {
  await withD1(async db => {
    await seed(db);
    const adopted = await write(db, ["account-a", "research"], {
      url: NEWS.shared1, status: "adopted", expectedVersion: 0, operationId: "op-url-1",
    });
    assert.equal(adopted.ok, true);

    const states = await read(db, ["account-a", "research"], [
      NEWS.shared1,
      NEWS.shared2,
      `${NEWS.shared1}?utm_source=feed`,
    ]);
    assert.equal(states.ok, true);
    assert.deepEqual(states.states.map(state => state.status), ["adopted", "unread", "unread"]);
    assert.notEqual(states.states[0].fingerprint, states.states[1].fingerprint);
    assert.notEqual(states.states[0].fingerprint, states.states[2].fingerprint);
    // A fragment is not part of the collected identity: it canonicalizes to the
    // same URL and therefore the same decision, not a second row.
    const fragment = await read(db, ["account-a", "research"], [`${NEWS.shared1}#comments`]);
    assert.deepEqual([fragment.states[0].status, fragment.states[0].version], ["adopted", 1]);
    assert.equal(fragment.states[0].fingerprint, states.states[0].fingerprint);
    assert.equal((await rows(db, "SELECT COUNT(*) AS n FROM guanlan_consumer_news_states"))[0].n, 1);
  });
});

test("real D1: the ledger enforces its own keys, bounds and tenant ownership", async () => {
  await withD1(async db => {
    await seed(db);
    const fingerprint = await fingerprintForCanonicalUrl(NEWS.shared1);
    const row = (overrides = {}) => [
      "account-a", "research", fingerprint, "shared", "adopted", null, null, stamp, 1, "op-1",
    ].map((value, index) => overrides[index] ?? value);

    const insertState = (...values) => db.prepare(`
      INSERT INTO guanlan_consumer_news_states (
        account_id, consumer_id, news_fingerprint, source_id,
        status, reason, outcome_url, decided_at, version, last_operation_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `).bind(...values).run();

    await insertState(...row());
    // Same key again: the primary key rejects a duplicate decision row.
    await assert.rejects(insertState(...row()));
    // The decision key is per consumer: a sibling consumer is a separate row.
    await insertState(...row({ 1: "radar" }));

    for (const [label, overrides] of [
      ["status", { 4: "unread" }],
      ["status-unknown", { 4: "done" }],
      ["fingerprint-length", { 2: "a".repeat(63) }],
      ["fingerprint-case", { 2: fingerprint.toUpperCase() }],
      ["fingerprint-chars", { 2: "g".repeat(64) }],
      ["source-empty", { 3: "" }],
      ["version-zero", { 8: 0 }],
      ["reason-untrimmed", { 5: " padded " }],
      ["reason-too-long", { 5: "x".repeat(501) }],
      ["outcome-not-url-bound", { 6: "x".repeat(2_049) }],
      ["operation-empty", { 9: "" }],
      ["operation-untrimmed", { 9: " op-2" }],
      // A consumer label that exists only under another account cannot own it.
      ["cross-account-consumer", { 0: "account-b", 1: "research" }],
    ]) {
      await assert.rejects(insertState(...row(overrides)), undefined, label);
    }
    assert.deepEqual(await rows(db, "PRAGMA foreign_key_check"), []);

    // Deleting a consumer removes its own decisions and nothing else.
    await insert(db, "DELETE FROM guanlan_consumers WHERE account_id = ? AND consumer_id = ?",
      "account-a", "research");
    assert.deepEqual(
      (await rows(db, "SELECT consumer_id FROM guanlan_consumer_news_states ORDER BY consumer_id"))
        .map(entry => entry.consumer_id),
      ["radar"],
    );
    // Deleting the shared news index leaves every decision intact (no FK).
    await insert(db, "DELETE FROM poc_news");
    assert.equal((await rows(db, "SELECT COUNT(*) AS n FROM guanlan_consumer_news_states"))[0].n, 1);
  });
});

test("real D1: a broken ledger is an explicit storage error, never unread success", async () => {
  await withD1(async db => {
    await seed(db);
    await db.prepare("DROP TABLE guanlan_consumer_news_states").run();
    await assert.rejects(
      read(db, ["account-a", "research"], [NEWS.shared1]),
      error => error instanceof ConsumptionLedgerError && error.code === "storage_failure",
    );
    await assert.rejects(
      write(db, ["account-a", "research"], {
        url: NEWS.shared1, status: "adopted", expectedVersion: 0, operationId: "op-broken",
      }),
      error => error instanceof ConsumptionLedgerError && error.code === "storage_failure",
    );
  });
});
