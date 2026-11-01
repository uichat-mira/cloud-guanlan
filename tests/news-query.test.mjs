import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NEWS_DEFAULT_STATUSES,
  NEWS_INPUT_SCHEMA,
  NEWS_LIMIT_MAX,
  NEWS_SCAN_CHUNK,
  NEWS_SCAN_CHUNK_MAX,
  NewsReadError,
  buildNewsChunkQuery,
  createAuthorizedNewsReader,
  decodeNewsCursor,
  encodeNewsCursor,
  escapeLikeTerm,
  newsFilterDigest,
  normalizeNewsQuery,
  renderNewsMarkdown,
  subjectFromPrincipal,
} from "../dist/news-unit.mjs";

// GLN-009 T1/T2: query contract, cursor binding, failure semantics and the
// read-only scan budget. Real workerd/D1 evidence is in news-workerd.test.mjs.

const principal = (accountId = "account-a", consumerId = "consumer-1") => ({
  accountId,
  consumerId,
  scopes: ["guanlan.read"],
  expiresAt: 4_102_444_800,
  issuer: "mira:cloud-auth",
  audience: "mira:cloud-guanlan",
});
const subject = (accountId, consumerId) => subjectFromPrincipal(principal(accountId, consumerId));

const newsRow = (url, ingestedAt = "2026-11-01T00:00:00.000Z", extra = {}) => ({
  url,
  source_id: extra.sourceId ?? "feed-1",
  title: extra.title ?? "Title " + url,
  summary: extra.summary ?? "Summary",
  published_at: extra.publishedAt ?? "2026-10-31T00:00:00.000Z",
  ingested_at: ingestedAt,
});

/** Fake D1: each `.all()` consumes the next queued row array. */
const fakeDb = batches => {
  const statements = [];
  const queue = [...batches];
  return {
    statements,
    prepare(sql) {
      const statement = {
        sql,
        values: null,
        async all() {
          const next = queue.length > 0 ? queue.shift() : [];
          if (next instanceof Error) throw next;
          return { success: true, results: next };
        },
      };
      statement.bind = (...values) => {
        statement.values = values;
        return statement;
      };
      statements.push(statement);
      return statement;
    },
  };
};

const fakeSubscriptions = ({ sourceIds = ["feed-1"], failure = null } = {}) => ({
  async read() {
    if (failure === "throw") throw new Error("d1 down");
    if (failure) return { ok: false, failure };
    return {
      ok: true,
      effective: {
        accountId: "account-a",
        consumerId: "consumer-1",
        sources: sourceIds.map(sourceId => ({
          sourceId, origin: "account", intervalHours: 1, intervalSource: "account",
        })),
        sourceIds,
        interests: [],
      },
    };
  },
});

const fakeLedger = (statuses = {}, { failure = null } = {}) => ({
  async read(_subject, request) {
    if (failure === "throw") throw new Error("ledger down");
    if (failure) return { ok: false, failure };
    return {
      ok: true,
      states: request.urls.map(url => ({
        url,
        fingerprint: "0".repeat(64),
        sourceId: "feed-1",
        status: statuses[url] ?? "unread",
        version: statuses[url] ? 1 : 0,
        reason: null,
        outcomeUrl: null,
        decidedAt: statuses[url] ? "2026-11-01T00:00:00.000Z" : null,
      })),
    };
  },
});

const reader = (db, { sourceIds, ledgerStatuses, ledgerFailure, subscriptionFailure } = {}) =>
  createAuthorizedNewsReader({
    db,
    subscriptions: fakeSubscriptions({ sourceIds: sourceIds ?? ["feed-1"], failure: subscriptionFailure }),
    ledger: fakeLedger(ledgerStatuses, { failure: ledgerFailure }),
  });

test("defaults are bounded: limit 20, unread+pending only, no filters", () => {
  const query = normalizeNewsQuery({});
  assert.equal(query.limit, 20);
  assert.deepEqual(query.statuses, [...NEWS_DEFAULT_STATUSES]);
  assert.deepEqual([...NEWS_DEFAULT_STATUSES], ["unread", "pending"]);
  assert.equal(query.sourceId, null);
  assert.deepEqual(query.terms, []);
  assert.equal(query.cursor, null);
});

test("limit is an integer inside 1..50", () => {
  assert.equal(normalizeNewsQuery({ limit: 1 }).limit, 1);
  assert.equal(normalizeNewsQuery({ limit: NEWS_LIMIT_MAX }).limit, NEWS_LIMIT_MAX);
  for (const bad of [0, 51, 1.5, -3, "10"]) {
    assert.throws(() => normalizeNewsQuery({ limit: bad }), error => {
      assert.ok(error instanceof NewsReadError);
      assert.equal(error.code, "invalid_query");
      return true;
    });
  }
});

test("status accepts a deduplicated subset in canonical order and rejects unknown values", () => {
  assert.deepEqual(normalizeNewsQuery({ status: ["adopted", "unread", "adopted"] }).statuses, ["unread", "adopted"]);
  assert.deepEqual(normalizeNewsQuery({ status: ["ignored"] }).statuses, ["ignored"]);
  for (const bad of [[], ["bogus"], ["unread", "pending", "adopted", "ignored", "unread"], "unread"]) {
    assert.throws(() => normalizeNewsQuery({ status: bad }), /status/);
  }
});

test("keyword is literal: whitespace-separated AND terms, ASCII-folded dedupe, bounded", () => {
  assert.deepEqual(normalizeNewsQuery({ keyword: "  Model   Context " }).terms, ["Model", "Context"]);
  assert.deepEqual(normalizeNewsQuery({ keyword: "AI ai" }).terms, ["AI"]);
  assert.throws(() => normalizeNewsQuery({ keyword: "   " }), /keyword/);
  assert.throws(() => normalizeNewsQuery({ keyword: "a".repeat(65) }), /keyword/);
  assert.throws(() => normalizeNewsQuery({ keyword: Array.from({ length: 9 }, (_, i) => "t" + i).join(" ") }), /keyword/);
  assert.throws(() => normalizeNewsQuery({ keyword: "a".repeat(101) + " " + "b".repeat(101) }), /keyword/);
});

test("LIKE metacharacters are escaped so a keyword cannot become a wildcard", () => {
  assert.equal(escapeLikeTerm("100%"), "100\\%");
  assert.equal(escapeLikeTerm("a_b"), "a\\_b");
  assert.equal(escapeLikeTerm("c\\d"), "c\\\\d");
  const filters = normalizeNewsQuery({ keyword: "100%_done" });
  const { sql, params } = buildNewsChunkQuery(filters, ["feed-1"], null, 20);
  assert.match(sql, /LIKE \? ESCAPE '\\'/);
  assert.deepEqual(params.filter(value => typeof value === "string" && value.startsWith("%")), [
    "%100\\%\\_done%", "%100\\%\\_done%",
  ]);
  assert.doesNotMatch(sql, /100%_done/);
});

test("time ranges are normalized to ISO instants and reversed ranges are rejected", () => {
  assert.equal(normalizeNewsQuery({ ingestedAfter: "2026-11-01T08:00:00+08:00" }).ingestedAfter, "2026-11-01T00:00:00.000Z");
  assert.equal(normalizeNewsQuery({ publishedBefore: "2026-11-01T00:00:00Z" }).publishedBefore, "2026-11-01T00:00:00.000Z");
  for (const bad of ["not-a-date", "2026-13-01T00:00:00Z", "x".repeat(80)]) {
    assert.throws(() => normalizeNewsQuery({ ingestedAfter: bad }), /ISO 8601|bound/);
  }
  assert.throws(
    () => normalizeNewsQuery({ ingestedAfter: "2026-11-02T00:00:00Z", ingestedBefore: "2026-11-01T00:00:00Z" }),
    /later than/,
  );
});

test("the chunk query binds every dynamic value and orders by the stable composite key", () => {
  const filters = normalizeNewsQuery({
    sourceId: "feed-1",
    status: ["unread"],
    keyword: "model",
    ingestedAfter: "2026-11-01T00:00:00Z",
    publishedBefore: "2026-11-02T00:00:00Z",
  });
  const { sql, params } = buildNewsChunkQuery(filters, ["feed-1", "feed-2"], { ingestedAt: "2026-11-01T00:00:00.000Z", url: "https://example.com/a" }, 50);
  assert.match(sql, /^SELECT url, source_id, title, summary, published_at, ingested_at FROM poc_news WHERE /);
  assert.match(sql, /ORDER BY ingested_at DESC, url ASC LIMIT \?$/);
  assert.match(sql, /source_id IN \(SELECT value FROM json_each\(\?\)\)/);
  assert.match(sql, /\(ingested_at < \? OR \(ingested_at = \? AND url > \?\)\)/);
  assert.equal(params[0], JSON.stringify(["feed-1", "feed-2"]));
  assert.equal(params.at(-1), 50);
  // No untrusted value is concatenated into the statement text.
  assert.doesNotMatch(sql, /feed-1|model|2026-/);
});

test("cursor round-trips, and is bound to identity and the exact filter set", async () => {
  const filters = normalizeNewsQuery({ status: ["adopted"] });
  const digest = await newsFilterDigest(subject(), filters);
  const position = { ingestedAt: "2026-11-01T00:00:00.000Z", url: "https://example.com/a" };
  const cursor = await encodeNewsCursor(subject(), digest, position);
  assert.deepEqual(await decodeNewsCursor(cursor, subject(), digest), position);

  // Cross-account / cross-consumer reuse is refused.
  await assert.rejects(decodeNewsCursor(cursor, subject("account-b", "consumer-1"), digest), /another identity/);
  await assert.rejects(decodeNewsCursor(cursor, subject("account-a", "consumer-2"), digest), /another identity/);
  // A different filter set (even the default vs explicit) invalidates it.
  const otherDigest = await newsFilterDigest(subject(), normalizeNewsQuery({ status: ["ignored"] }));
  await assert.rejects(decodeNewsCursor(cursor, subject(), otherDigest), /another filter set/);
  // A tampered cursor fails its integrity value.
  const flipped = cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A");
  await assert.rejects(decodeNewsCursor(flipped, subject(), digest), /modified|not valid JSON|not decodable/);
  // Garbage and oversized values are explicit cursor errors.
  for (const bad of ["not-a-cursor", "a".repeat(20_000), "", "%%%"]) {
    await assert.rejects(decodeNewsCursor(bad, subject(), digest), error => {
      assert.ok(error instanceof NewsReadError);
      assert.equal(error.code, "invalid_cursor");
      return true;
    });
  }
});

test("an empty effective source set is an empty page and never touches the index", async () => {
  const db = fakeDb([]);
  const page = await reader(db, { sourceIds: [] }).listPage(principal(), {});
  assert.deepEqual(page, { items: [], count: 0, limit: 20, nextCursor: null });
  assert.equal(db.statements.length, 0);
});

test("a source id outside the effective set is answered with an empty page, not a probe", async () => {
  const db = fakeDb([]);
  const page = await reader(db, { sourceIds: ["feed-1"] }).listPage(principal(), { sourceId: "feed-secret" });
  assert.deepEqual(page, { items: [], count: 0, limit: 20, nextCursor: null });
  assert.equal(db.statements.length, 0);
});

test("bad cursors remain explicit errors on empty-authorized and denied-source reads", async () => {
  const db = fakeDb([]);
  await assert.rejects(
    reader(db, { sourceIds: [] }).listPage(principal(), { cursor: "not-a-cursor" }),
    error => error instanceof NewsReadError && error.code === "invalid_cursor",
  );
  await assert.rejects(
    reader(db, { sourceIds: ["feed-1"] }).listPage(principal(), {
      sourceId: "feed-secret", cursor: "not-a-cursor",
    }),
    error => error instanceof NewsReadError && error.code === "invalid_cursor",
  );
  assert.equal(db.statements.length, 0, "cursor validation must not read the news index");
});

test("unprovisioned and broken subscriptions fail explicitly, never as an empty page", async () => {
  for (const [failure, code] of [
    ["account_not_found", "principal_unavailable"],
    ["consumer_not_found", "principal_unavailable"],
    ["invalid_subject", "invalid_subject"],
  ]) {
    await assert.rejects(
      reader(fakeDb([]), { subscriptionFailure: failure }).listPage(principal(), {}),
      error => {
        assert.equal(error.code, code);
        return true;
      },
    );
  }
  await assert.rejects(
    reader(fakeDb([]), { subscriptionFailure: "throw" }).listPage(principal(), {}),
    error => {
      assert.equal(error.code, "storage_failure");
      return true;
    },
  );
});

test("a ledger failure is a storage failure, never an implied unread page", async () => {
  for (const failure of ["throw", "news_not_found", "source_not_authorized"]) {
    const db = fakeDb([[newsRow("https://example.com/a")]]);
    await assert.rejects(
      reader(db, { ledgerFailure: failure }).listPage(principal(), {}),
      error => {
        assert.equal(error.code, "storage_failure");
        return true;
      },
    );
  }
});

test("status filtering, page fill and continuation cursor follow the scanned stream", async () => {
  const rows = [
    newsRow("https://example.com/a"),
    newsRow("https://example.com/b"),
    newsRow("https://example.com/c"),
  ];
  const db = fakeDb([rows]);
  const page = await reader(db, {
    ledgerStatuses: { "https://example.com/b": "adopted" },
  }).listPage(principal(), { limit: 2 });
  // b is adopted and therefore outside the default unread+pending page.
  assert.deepEqual(page.items.map(item => item.url), ["https://example.com/a", "https://example.com/c"]);
  assert.equal(page.count, 2);
  assert.equal(page.limit, 2);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(page.items.map(item => item.status), ["unread", "unread"]);
});

test("an explicit history status returns adopted/ignored items and their status", async () => {
  const rows = [newsRow("https://example.com/b"), newsRow("https://example.com/c")];
  const db = fakeDb([rows]);
  const page = await reader(db, {
    ledgerStatuses: { "https://example.com/b": "adopted", "https://example.com/c": "ignored" },
  }).listPage(principal(), { status: ["adopted", "ignored"] });
  assert.deepEqual(page.items.map(item => [item.url, item.status]), [
    ["https://example.com/b", "adopted"],
    ["https://example.com/c", "ignored"],
  ]);
});

test("a filled page returns a cursor that resumes exactly after the last scanned row", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => newsRow("https://example.com/" + i));
  const db = fakeDb([rows]);
  const page = await reader(db, {}).listPage(principal(), { limit: 2 });
  assert.equal(page.items.length, 2);
  assert.ok(page.nextCursor);
  const filters = normalizeNewsQuery({ limit: 2 });
  const digest = await newsFilterDigest(subject(), filters);
  const position = await decodeNewsCursor(page.nextCursor, subject(), digest);
  assert.deepEqual(position, { ingestedAt: "2026-11-01T00:00:00.000Z", url: "https://example.com/1" });
});

test("the per-request scan budget is hard-bounded and returns a continuation cursor", async () => {
  const chunk = Array.from({ length: NEWS_SCAN_CHUNK }, (_, i) =>
    newsRow("https://example.com/c" + i, "2026-11-01T00:00:00.000Z"));
  // Every scanned row is a stored decision outside the default page, so the
  // status filter never fills the page and the scan must stop at the budget.
  const ledgerStatuses = Object.fromEntries(chunk.map(row => [row.url, "adopted"]));
  const batches = Array.from({ length: NEWS_SCAN_CHUNK_MAX }, () => chunk);
  const db = fakeDb(batches);
  const page = await reader(db, { ledgerStatuses }).listPage(principal(), {});
  // No row matches the default unread+pending filter, but the scan is bounded:
  // an empty page with a cursor, not an unbounded sweep of the whole index.
  assert.equal(page.items.length, 0);
  assert.ok(page.nextCursor);
  assert.equal(db.statements.length, NEWS_SCAN_CHUNK_MAX);
});

test("every emitted statement is a read; the reader has no write path", async () => {
  const db = fakeDb([[newsRow("https://example.com/a")]]);
  await reader(db, {}).listPage(principal(), {});
  assert.ok(db.statements.length >= 1);
  for (const statement of db.statements) {
    assert.match(statement.sql.trim(), /^SELECT\b/i);
    assert.doesNotMatch(statement.sql, /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i);
  }
});

test("the MCP input schema validates the same bounds", () => {
  assert.equal(NEWS_INPUT_SCHEMA.safeParse({}).success, true);
  assert.equal(NEWS_INPUT_SCHEMA.safeParse({ limit: 50, status: ["unread"], keyword: "model" }).success, true);
  assert.equal(NEWS_INPUT_SCHEMA.safeParse({ limit: 51 }).success, false);
  assert.equal(NEWS_INPUT_SCHEMA.safeParse({ status: ["bogus"] }).success, false);
  assert.equal(NEWS_INPUT_SCHEMA.safeParse({ status: [] }).success, false);
  assert.equal(NEWS_INPUT_SCHEMA.safeParse({ keyword: "x".repeat(201) }).success, false);
  assert.equal(NEWS_INPUT_SCHEMA.safeParse({ cursor: "x".repeat(12_001) }).success, false);
  assert.equal(NEWS_INPUT_SCHEMA.safeParse({ sourceId: "x".repeat(2_049) }).success, false);
});

test("Markdown and JSON render the same page, including status, size and cursor", () => {
  const page = {
    items: [{
      id: "https://example.com/a",
      title: "A title",
      summary: "A summary",
      url: "https://example.com/a",
      sourceId: "feed-1",
      publishedAt: "2026-10-31T00:00:00.000Z",
      ingestedAt: "2026-11-01T00:00:00.000Z",
      status: "pending",
    }],
    count: 1,
    limit: 20,
    nextCursor: "opaque-cursor",
  };
  const markdown = renderNewsMarkdown(page);
  assert.match(markdown, /1 item\(s\)/);
  assert.match(markdown, /Page size: 20 · Returned: 1 · Next cursor: opaque-cursor/);
  assert.match(markdown, /Status: pending/);
  assert.match(markdown, /URL: https:\/\/example\.com\/a/);
  assert.match(markdown, /A summary/);
  assert.match(renderNewsMarkdown({ items: [], count: 0, limit: 20, nextCursor: null }), /No news items match this authorized query/);
  const sparse = renderNewsMarkdown({ items: [], count: 0, limit: 20, nextCursor: "continue-here" });
  assert.match(sparse, /More authorized news may exist/);
  assert.match(sparse, /continue-here/);
  assert.doesNotMatch(sparse, /No news items match this authorized query/);
});
