import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INTERVAL_HOURS_MAX,
  SUBJECT_ID_MAX,
  SubscriptionReadError,
  buildEffectiveConfiguration,
  createD1SubscriptionReader,
  subjectFromPrincipal,
} from "../dist/subscriptions-unit.mjs";

// GLN-006 T1/T2: the merge/precedence contract and the failure semantics of the
// domain port. Real workerd/D1 evidence lives in subscriptions-workerd.test.mjs.

const source = (sourceId, intervalHours, level) => ({ sourceId, intervalHours, level });
const interest = (kind, value, level) => ({ kind, value, level });
const principal = (accountId = "account-a", consumerId = "research") => ({
  accountId,
  consumerId,
  scopes: ["guanlan.read"],
  expiresAt: 4_102_444_800,
  issuer: "mira:cloud-auth",
  audience: "mira:cloud-guanlan",
});
const subject = () => subjectFromPrincipal(principal());
const result = results => ({ success: true, results, meta: {} });

const fakeDb = (batch) => {
  const prepared = [];
  return {
    prepared,
    prepare(sql) {
      prepared.push(sql);
      return { bind: (...values) => ({ sql, values }) };
    },
    batch,
  };
};

test("trusted subject construction rejects principals that are not usable identities", () => {
  const built = subjectFromPrincipal(principal());
  assert.equal(built.accountId, "account-a");
  assert.equal(built.consumerId, "research");

  for (const [accountId, consumerId] of [
    ["", "research"],
    ["account-a", ""],
    [" account-a", "research"],
    ["account-a", "research "],
    ["a".repeat(SUBJECT_ID_MAX + 1), "research"],
    [null, "research"],
    ["account-a", 7],
  ]) {
    assert.throws(
      () => subjectFromPrincipal({ ...principal(), accountId, consumerId }),
      error => error instanceof SubscriptionReadError && error.code === "invalid_subject",
    );
  }
  // The bound itself is inclusive, matching the 0003 CHECK constraint.
  assert.equal(
    subjectFromPrincipal({ ...principal(), accountId: "a".repeat(SUBJECT_ID_MAX) }).accountId.length,
    SUBJECT_ID_MAX,
  );
});

test("an invalid subject is refused before any database statement is prepared", async () => {
  const db = fakeDb(() => {
    throw new Error("the database must not be touched for an invalid subject");
  });
  db.prepare = () => {
    throw new Error("the database must not be touched for an invalid subject");
  };
  const reader = createD1SubscriptionReader(db);
  assert.deepEqual(
    await reader.read({ accountId: "", consumerId: "research" }),
    { ok: false, failure: "invalid_subject" },
  );
  assert.deepEqual(
    await reader.read({ accountId: "account-a", consumerId: "x".repeat(SUBJECT_ID_MAX + 1) }),
    { ok: false, failure: "invalid_subject" },
  );
});

test("account baseline and consumer increment merge into one deterministic, deduplicated view", () => {
  const effective = buildEffectiveConfiguration(
    "account-a",
    "research",
    [
      source("shared", 4, "account"),
      source("account-only", 2, "account"),
      source("shared", 1, "consumer"),
      source("consumer-only", 1, "consumer"),
    ],
    [
      interest("keyword", "Science", "account"),
      interest("topic", "Space", "account"),
      interest("keyword", "SCIENCE", "consumer"),
      interest("topic", "Robotics", "consumer"),
    ],
  );

  assert.deepEqual(effective.sources, [
    { sourceId: "account-only", origin: "account", intervalHours: 2, intervalSource: "account" },
    { sourceId: "consumer-only", origin: "consumer", intervalHours: 1, intervalSource: "consumer" },
    // Both levels reference the same shared source: one entry, consumer
    // preference wins, provenance records the account baseline too.
    { sourceId: "shared", origin: "both", intervalHours: 1, intervalSource: "consumer" },
  ]);
  assert.deepEqual(effective.sourceIds, ["account-only", "consumer-only", "shared"]);
  assert.deepEqual(effective.interests, [
    // Case-insensitive dedupe keeps the account's stored spelling.
    { kind: "keyword", value: "Science", origin: "both" },
    { kind: "topic", value: "Robotics", origin: "consumer" },
    { kind: "topic", value: "Space", origin: "account" },
  ]);
  assert.equal(effective.accountId, "account-a");
  assert.equal(effective.consumerId, "research");
});

test("the same value under different kinds stays two interests, and same-kind duplicates collapse", () => {
  const effective = buildEffectiveConfiguration("account-a", "research", [], [
    interest("keyword", "Science", "account"),
    interest("topic", "Science", "account"),
    interest("keyword", "science", "consumer"),
    interest("keyword", "Science", "consumer"),
  ]);
  assert.deepEqual(effective.interests, [
    { kind: "keyword", value: "Science", origin: "both" },
    { kind: "topic", value: "Science", origin: "account" },
  ]);
});

test("output order is stable regardless of row order and duplicates never repeat a source", () => {
  const rows = [
    source("zeta", 1, "consumer"),
    source("alpha", 3, "account"),
    source("mid", 2, "account"),
    source("zeta", 1, "consumer"),
  ];
  const forward = buildEffectiveConfiguration("account-a", "research", rows, []);
  const reversed = buildEffectiveConfiguration("account-a", "research", [...rows].reverse(), []);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward.sourceIds, ["alpha", "mid", "zeta"]);
  assert.equal(new Set(forward.sourceIds).size, forward.sourceIds.length);
  // A source with only a consumer row must not claim an account baseline.
  assert.equal(forward.sources[2].origin, "consumer");
});

test("a row outside the stored contract fails explicitly instead of being coerced", () => {
  const bad = [
    [[source("shared", 0, "account")], []],
    [[source("shared", INTERVAL_HOURS_MAX + 1, "account")], []],
    [[source("shared", 1.5, "account")], []],
    [[source(" shared", 1, "account")], []],
    [[source("", 1, "account")], []],
    [[source("shared", 1, "account")], [interest("tag", "Science", "account")]],
    [[source("shared", 1, "account")], [interest("keyword", "", "account")]],
    [[source("shared", 1, "account")], [interest("keyword", " padded ", "account")]],
    [[source("shared", 1, "account")], [interest("keyword", "x".repeat(129), "account")]],
  ];
  for (const [sources, interests] of bad) {
    assert.throws(
      () => buildEffectiveConfiguration("account-a", "research", sources, interests),
      error => error instanceof SubscriptionReadError && error.code === "storage_failure",
    );
  }
});

test("missing account and missing consumer are explicit denials, not empty success", async () => {
  const cases = [
    [[{ accounts: 0, consumers: 0 }], "account_not_found"],
    [[{ accounts: 1, consumers: 0 }], "consumer_not_found"],
  ];
  for (const [existence, failure] of cases) {
    const reader = createD1SubscriptionReader(
      fakeDb(async () => [result(existence), result([]), result([])]),
    );
    assert.deepEqual(await reader.read(subject()), { ok: false, failure });
  }
});

test("a reader that verifies the subject but stores nothing returns an empty, explicit set", async () => {
  const reader = createD1SubscriptionReader(
    fakeDb(async () => [result([{ accounts: 1, consumers: 1 }]), result([]), result([])]),
  );
  const read = await reader.read(subject());
  assert.equal(read.ok, true);
  assert.deepEqual(read.effective.sources, []);
  assert.deepEqual(read.effective.sourceIds, []);
  assert.deepEqual(read.effective.interests, []);
  // Empty is a positive answer about this subject, never a global fallback.
  assert.equal("items" in read.effective, false);
});

test("a database failure is an explicit storage error, never an empty configuration", async () => {
  const broken = createD1SubscriptionReader(fakeDb(async () => {
    throw new Error("d1 unavailable");
  }));
  await assert.rejects(
    broken.read(subject()),
    error => error instanceof SubscriptionReadError && error.code === "storage_failure",
  );

  const unsuccessful = createD1SubscriptionReader(
    fakeDb(async () => [
      { success: false, results: [], meta: {} },
      result([]),
      result([]),
    ]),
  );
  await assert.rejects(
    unsuccessful.read(subject()),
    error => error instanceof SubscriptionReadError && error.code === "storage_failure",
  );
});

test("a malformed existence payload is a storage failure, never an empty success", async () => {
  // The authorization gate must not treat a lost or reshaped payload as
  // "this subject has no configuration".
  for (const existence of [[], [{}], [{ accounts: 1 }], [{ accounts: "1", consumers: "1" }], undefined]) {
    const reader = createD1SubscriptionReader(
      fakeDb(async () => [result(existence), result([]), result([])]),
    );
    await assert.rejects(
      reader.read(subject()),
      error => error instanceof SubscriptionReadError && error.code === "storage_failure",
      JSON.stringify(existence),
    );
  }
  // Same for a lost source/interest result set.
  for (const index of [1, 2]) {
    const results = [result([{ accounts: 1, consumers: 1 }]), result([]), result([])];
    results[index] = { success: true, results: undefined, meta: {} };
    const reader = createD1SubscriptionReader(fakeDb(async () => results));
    await assert.rejects(
      reader.read(subject()),
      error => error instanceof SubscriptionReadError && error.code === "storage_failure",
    );
  }
});

test("the consumer preference wins in both directions, not min or max", () => {
  const higher = buildEffectiveConfiguration("account-a", "research", [
    source("shared", 2, "account"),
    source("shared", 8, "consumer"),
  ], []);
  assert.deepEqual(higher.sources, [
    { sourceId: "shared", origin: "both", intervalHours: 8, intervalSource: "consumer" },
  ]);
  const lower = buildEffectiveConfiguration("account-a", "research", [
    source("shared", 8, "account"),
    source("shared", 2, "consumer"),
  ], []);
  assert.deepEqual(lower.sources, [
    { sourceId: "shared", origin: "both", intervalHours: 2, intervalSource: "consumer" },
  ]);
});

test("same-level ASCII-case duplicates keep a row-order-independent spelling", () => {
  const forward = buildEffectiveConfiguration("account-a", "research", [], [
    interest("keyword", "SCIENCE", "account"),
    interest("keyword", "science", "account"),
  ]);
  const reversed = buildEffectiveConfiguration("account-a", "research", [], [
    interest("keyword", "science", "account"),
    interest("keyword", "SCIENCE", "account"),
  ]);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward.interests, [{ kind: "keyword", value: "SCIENCE", origin: "account" }]);
});

test("the reader issues only SELECT statements in one batch and never a write", async () => {
  const db = fakeDb(async () => [result([{ accounts: 1, consumers: 1 }]), result([]), result([])]);
  await createD1SubscriptionReader(db).read(subject());
  assert.equal(db.prepared.length, 3);
  for (const sql of db.prepared) {
    assert.match(sql.trim(), /^SELECT\b/i);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE)\b/i);
    assert.doesNotMatch(sql, /\bpoc_sources\b|\bpoc_news\b/);
  }
});
