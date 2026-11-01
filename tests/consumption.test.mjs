import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CONSUMPTION_BATCH_MAX,
  CONSUMPTION_OPERATION_ID_MAX,
  CONSUMPTION_REASON_MAX,
  ConsumptionLedgerError,
  createD1ConsumptionLedger,
  fingerprintForCanonicalUrl,
  fingerprintNewsUrl,
} from "../dist/consumption-unit.mjs";
import { subjectFromPrincipal } from "../dist/subscriptions-unit.mjs";

// GLN-007 T1/T2: identity, request/response contract and failure semantics of the
// domain port. Real workerd/D1 evidence lives in consumption-workerd.test.mjs.

const stamp = "2026-11-01T00:00:00.000Z";
const principal = (accountId = "account-a", consumerId = "research") => ({
  accountId,
  consumerId,
  scopes: ["guanlan.write"],
  expiresAt: 4_102_444_800,
  issuer: "mira:cloud-auth",
  audience: "mira:cloud-guanlan",
});
const subject = () => subjectFromPrincipal(principal());

const subscriptionReader = (sourceIds = ["shared"], failure = null) => ({
  async read() {
    if (failure) return { ok: false, failure };
    return {
      ok: true,
      effective: {
        accountId: "account-a",
        consumerId: "research",
        sources: sourceIds.map(sourceId => ({
          sourceId, origin: "account", intervalHours: 1, intervalSource: "account",
        })),
        sourceIds,
        interests: [],
      },
    };
  },
});

const readOk = results => ({ success: true, results, meta: {} });
const writeOk = changes => ({ success: true, results: [], meta: { changes } });

/** `batches` is consumed one call at a time; an Error entry is thrown. */
const fakeDb = batches => {
  const prepared = [];
  const queue = [...batches];
  return {
    prepared,
    prepare(sql) {
      const statement = {
        sql,
        values: null,
        bind: (...values) => {
          statement.values = values;
          return statement;
        },
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements) {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next(statements);
      return next;
    },
  };
};

const ledger = (db, { sourceIds = ["shared"], failure = null } = {}) =>
  createD1ConsumptionLedger({
    db,
    subscriptions: subscriptionReader(sourceIds, failure),
    now: () => new Date(stamp),
  });

const newsRow = (url, sourceId = "shared") => ({ url, source_id: sourceId });
const ledgerRow = (fingerprint, overrides = {}) => ({
  news_fingerprint: fingerprint,
  source_id: "shared",
  status: "adopted",
  reason: null,
  outcome_url: null,
  decided_at: stamp,
  version: 1,
  last_operation_id: "op-1",
  ...overrides,
});
const writeRequest = (overrides = {}) => ({
  url: "https://example.com/a",
  status: "adopted",
  expectedVersion: 0,
  operationId: "op-1",
  ...overrides,
});

test("canonical identity follows the collection rule, is deterministic and is a SHA-256 fingerprint", async () => {
  const canonical = "https://example.com/story/1?a=1";
  const expected = createHash("sha256").update(canonical, "utf8").digest("hex");
  assert.equal(await fingerprintForCanonicalUrl(canonical), expected);
  assert.equal(await fingerprintNewsUrl(canonical), expected);
  assert.match(expected, /^[0-9a-f]{64}$/);

  // Same collection rule as `poc_news.url`: fragment dropped, host folded.
  assert.equal(await fingerprintNewsUrl("https://example.com/story/1?a=1#section"), expected);
  assert.equal(await fingerprintNewsUrl("https://EXAMPLE.com/story/1?a=1"), expected);
  // Path case and query string are identity-bearing: never merged.
  assert.notEqual(await fingerprintNewsUrl("https://example.com/Story/1?a=1"), expected);
  assert.notEqual(await fingerprintNewsUrl("https://example.com/story/1?a=2"), expected);
  assert.notEqual(await fingerprintNewsUrl("https://example.com/story/1"), expected);
  // Non-fetchable or relative values are not news identities.
  for (const bad of [
    "javascript:alert(1)", "data:text/plain,x", "ftp://example.com/a",
    "https://user:pass@example.com/a", "/story/1", "", "not a url",
  ]) {
    assert.equal(await fingerprintNewsUrl(bad), null, bad);
  }
});

test("an invalid subject is refused before any database statement is prepared", async () => {
  const db = fakeDb([]);
  db.prepare = () => {
    throw new Error("the database must not be touched for an invalid subject");
  };
  const port = ledger(db);
  for (const bad of [
    { accountId: "", consumerId: "research" },
    { accountId: "account-a", consumerId: " " },
    { accountId: "a".repeat(129), consumerId: "research" },
    { accountId: "account-a", consumerId: 7 },
  ]) {
    assert.deepEqual(
      await port.read(bad, { urls: ["https://example.com/a"] }),
      { ok: false, failure: "invalid_subject" },
    );
    assert.deepEqual(
      await port.write(bad, writeRequest()),
      { ok: false, failure: "invalid_subject" },
    );
  }
});

test("read request shape is validated and duplicate URLs collapse to one identity", async () => {
  const db = fakeDb([]);
  const port = ledger(db);
  for (const request of [
    undefined,
    {},
    { urls: [] },
    { urls: ["https://example.com/a", 7] },
    { urls: ["/relative"] },
    { urls: Array.from({ length: CONSUMPTION_BATCH_MAX + 1 }, (_, i) => `https://example.com/${i}`) },
  ]) {
    assert.deepEqual(await port.read(subject(), request), { ok: false, failure: "invalid_request" });
  }
  assert.equal(db.prepared.length, 0, "invalid requests must not reach the database");

  const fingerprint = await fingerprintForCanonicalUrl("https://example.com/a");
  const collapsing = fakeDb([
    [readOk([ledgerRow(fingerprint)]), readOk([newsRow("https://example.com/a")])],
  ]);
  const read = await ledger(collapsing).read(subject(), {
    urls: ["https://example.com/a", "https://example.com/a#again", "https://EXAMPLE.com/a"],
  });
  assert.equal(read.ok, true);
  assert.equal(read.states.length, 1);
  assert.equal(read.states[0].version, 1);
});

test("a pure read issues only SELECT statements and reports implied unread without writing", async () => {
  const fingerprint = await fingerprintForCanonicalUrl("https://example.com/a");
  const db = fakeDb([[readOk([]), readOk([newsRow("https://example.com/a")])]]);
  const read = await ledger(db).read(subject(), { urls: ["https://example.com/a"] });

  assert.deepEqual(read, {
    ok: true,
    states: [{
      url: "https://example.com/a",
      fingerprint,
      sourceId: "shared",
      status: "unread",
      version: 0,
      reason: null,
      outcomeUrl: null,
      decidedAt: null,
    }],
  });
  assert.equal(db.prepared.length, 2);
  for (const statement of db.prepared) {
    assert.match(statement.sql.trim(), /^SELECT\b/i);
    assert.doesNotMatch(statement.sql, /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b/i);
  }
});

test("read denials are explicit: unknown news, unauthorized source, missing owner", async () => {
  const fingerprint = await fingerprintForCanonicalUrl("https://example.com/a");
  const url = "https://example.com/a";

  const cases = [
    { batches: [[readOk([]), readOk([])]], failure: "news_not_found" },
    { batches: [[readOk([]), readOk([newsRow(url, "other")])]], failure: "source_not_authorized" },
    {
      batches: [[readOk([ledgerRow(fingerprint, { source_id: "other" })]), readOk([])]],
      failure: "source_not_authorized",
    },
    { batches: [], failure: "account_not_found", subscriptionFailure: "account_not_found" },
    { batches: [], failure: "consumer_not_found", subscriptionFailure: "consumer_not_found" },
    { batches: [], failure: "invalid_subject", subscriptionFailure: "invalid_subject" },
  ];
  for (const item of cases) {
    const db = fakeDb(item.batches);
    const read = await ledger(db, { failure: item.subscriptionFailure ?? null })
      .read(subject(), { urls: [url] });
    assert.deepEqual(read, { ok: false, failure: item.failure });
    assert.equal("states" in read, false);
  }
});

test("write request validation happens before the database and rejects out-of-contract values", async () => {
  const db = fakeDb([]);
  const port = ledger(db);
  const invalid = [
    writeRequest({ status: "unread" }),
    writeRequest({ status: "done" }),
    writeRequest({ expectedVersion: -1 }),
    writeRequest({ expectedVersion: 1.5 }),
    writeRequest({ expectedVersion: "0" }),
    writeRequest({ operationId: "" }),
    writeRequest({ operationId: " op-1" }),
    writeRequest({ operationId: "x".repeat(CONSUMPTION_OPERATION_ID_MAX + 1) }),
    writeRequest({ reason: "x".repeat(CONSUMPTION_REASON_MAX + 1) }),
    writeRequest({ reason: " padded reason " }),
    writeRequest({ reason: 42 }),
    writeRequest({ outcomeUrl: "javascript:alert(1)" }),
    writeRequest({ outcomeUrl: "https://user:pass@example.com/result" }),
    writeRequest({ outcomeUrl: "x".repeat(2_049) }),
    writeRequest({ url: "/relative" }),
    writeRequest({ url: "ftp://example.com/a" }),
    null,
  ];
  for (const request of invalid) {
    assert.deepEqual(await port.write(subject(), request), { ok: false, failure: "invalid_request" });
  }
  assert.equal(db.prepared.length, 0, "invalid requests must not reach the database");
});

test("the write path is one guarded upsert batch with CAS and idempotency inside the statement", async () => {
  const fingerprint = await fingerprintForCanonicalUrl("https://example.com/a");
  const db = fakeDb([
    [writeOk(1), readOk([ledgerRow(fingerprint)]), readOk([newsRow("https://example.com/a")])],
  ]);
  const write = await ledger(db).write(subject(), writeRequest({
    expectedVersion: 3, operationId: "op-3", reason: "used in report", outcomeUrl: "https://example.com/report",
  }));
  assert.equal(write.ok, true);
  assert.equal(write.result, "updated");

  assert.equal(db.prepared.length, 3);
  const [upsert, current, news] = db.prepared;
  assert.match(upsert.sql.trim(), /^INSERT\b/i);
  // The version guard and replay guard are part of the statement, not a
  // read-then-write race in JavaScript.
  assert.match(upsert.sql, /ON CONFLICT/i);
  assert.match(upsert.sql, /guanlan_consumer_news_states\.version = \?/);
  assert.match(upsert.sql, /AND \(\? = 0 OR EXISTS \(/);
  assert.match(upsert.sql, /last_operation_id <> \?/);
  assert.match(upsert.sql, /json_each\(\?\)/);
  // The authorized source set handed to SQL comes from GLN-006.
  assert.ok(upsert.values.includes(JSON.stringify(["shared"])));
  assert.ok(upsert.values.includes(3));
  assert.ok(upsert.values.includes("op-3"));
  assert.match(current.sql.trim(), /^SELECT\b/i);
  assert.match(news.sql.trim(), /^SELECT\b/i);
  // No separate UPDATE/DELETE statement: the state change happens only inside
  // the guarded upsert, so there is no read-then-write window in JavaScript.
  for (const statement of db.prepared) {
    assert.match(statement.sql.trim(), /^(INSERT|SELECT)\b/i);
  }
});

test("write classification is deterministic for update, replay, operation conflict and version conflict", async () => {
  const fingerprint = await fingerprintForCanonicalUrl("https://example.com/a");
  const url = "https://example.com/a";
  const news = readOk([newsRow(url)]);

  const run = async (batches, request = writeRequest()) =>
    ledger(fakeDb([batches])).write(subject(), request);

  const updated = await run([writeOk(1), readOk([ledgerRow(fingerprint)]), news]);
  assert.equal(updated.ok, true);
  assert.equal(updated.result, "updated");
  assert.equal(updated.state.version, 1);
  assert.equal(updated.state.status, "adopted");

  // Exact retry: same operation, same payload, original expectedVersion. The
  // replay check precedes the version check so a lost response is recoverable.
  const replayed = await run([writeOk(0), readOk([ledgerRow(fingerprint)]), news]);
  assert.equal(replayed.ok, true);
  assert.equal(replayed.result, "replayed");
  assert.equal(replayed.state.version, 1);
  assert.equal(replayed.state.decidedAt, stamp);

  // Same operation id, different decision: a client bug, never silently applied.
  const operationConflict = await run(
    [writeOk(0), readOk([ledgerRow(fingerprint)]), news],
    writeRequest({ status: "ignored", expectedVersion: 1 }),
  );
  assert.equal(operationConflict.ok, false);
  assert.equal(operationConflict.failure, "operation_conflict");
  assert.equal(operationConflict.current.status, "adopted");
  assert.equal(operationConflict.current.version, 1);

  // A stale expectation for an absent row must not be allowed to insert it.
  const missingExpectedRow = await run(
    [writeOk(0), readOk([]), news],
    writeRequest({ expectedVersion: 7, operationId: "op-missing" }),
  );
  assert.equal(missingExpectedRow.ok, false);
  assert.equal(missingExpectedRow.failure, "version_conflict");
  assert.deepEqual(
    [missingExpectedRow.current.status, missingExpectedRow.current.version],
    ["unread", 0],
  );

  // A stale expected version cannot overwrite a newer decision.
  const versionConflict = await run(
    [writeOk(0), readOk([ledgerRow(fingerprint, { version: 4, last_operation_id: "op-4", status: "ignored" })]), news],
    writeRequest({ status: "pending", expectedVersion: 1 }),
  );
  assert.equal(versionConflict.ok, false);
  assert.equal(versionConflict.failure, "version_conflict");
  assert.equal(versionConflict.current.version, 4);
  assert.equal(versionConflict.current.status, "ignored");

  // Denials never report success and never masquerade as unread.
  assert.deepEqual(
    await run([writeOk(0), readOk([]), readOk([])]),
    { ok: false, failure: "news_not_found" },
  );
  assert.deepEqual(
    await run([writeOk(0), readOk([]), readOk([newsRow(url, "other")])]),
    { ok: false, failure: "source_not_authorized" },
  );
  // Authorization is decided before replay: an unsubscribed source is a denial
  // even when the caller replays an operation that once succeeded.
  const deniedReplay = await run([writeOk(0), readOk([ledgerRow(fingerprint)]), readOk([newsRow(url, "other")])]);
  assert.deepEqual(deniedReplay, { ok: false, failure: "source_not_authorized" });
});

test("storage failures and out-of-contract rows are explicit errors, never unread success", async () => {
  const fingerprint = await fingerprintForCanonicalUrl("https://example.com/a");
  const url = "https://example.com/a";
  const isStorageFailure = error =>
    error instanceof ConsumptionLedgerError && error.code === "storage_failure";

  await assert.rejects(
    ledger(fakeDb([new Error("d1 unavailable")])).read(subject(), { urls: [url] }),
    isStorageFailure,
  );
  await assert.rejects(
    ledger(fakeDb([[{ success: false, results: [], meta: {} }, readOk([])]]))
      .read(subject(), { urls: [url] }),
    isStorageFailure,
  );
  await assert.rejects(
    ledger(fakeDb([[readOk([{ ...ledgerRow(fingerprint), status: "unread" }]), readOk([])]]))
      .read(subject(), { urls: [url] }),
    isStorageFailure,
  );
  await assert.rejects(
    ledger(fakeDb([[readOk([{ ...ledgerRow(fingerprint), version: 0 }]), readOk([])]]))
      .read(subject(), { urls: [url] }),
    isStorageFailure,
  );
  await assert.rejects(
    ledger(fakeDb([[readOk([ledgerRow("f".repeat(63))]), readOk([])]]))
      .read(subject(), { urls: [url] }),
    isStorageFailure,
  );
  await assert.rejects(
    ledger(fakeDb([new Error("d1 unavailable")])).write(subject(), writeRequest()),
    isStorageFailure,
  );
  await assert.rejects(
    ledger(fakeDb([[writeOk(2), readOk([]), readOk([newsRow(url)])]])).write(subject(), writeRequest()),
    isStorageFailure,
  );
  // A row written but invisible to the same-transaction read is an anomaly.
  await assert.rejects(
    ledger(fakeDb([[writeOk(1), readOk([]), readOk([newsRow(url)])]])).write(subject(), writeRequest()),
    isStorageFailure,
  );
});
