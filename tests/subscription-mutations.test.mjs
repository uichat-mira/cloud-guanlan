import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SubscriptionMutationError,
  createD1SubscriptionMutator,
  managementGrantFromPrincipal,
} from "../dist/subscription-mutations-unit.mjs";

// GLN-011 T1/T2: the authorization boundary, the mutation DTO contract and the
// failure semantics of the write port. Real workerd/D1 evidence lives in
// subscription-mutations-workerd.test.mjs.

const APPROVED = "https://developers.cloudflare.com/changelog/rss/index.xml";
const UNAPPROVED = "https://example.com/rss.xml";

const principal = (
  accountId = "account-a",
  consumerId = "research",
  scopes = ["test:manage-account"],
) => ({
  accountId,
  consumerId,
  scopes,
  expiresAt: 4_102_444_800,
  issuer: "mira:cloud-auth",
  audience: "mira:cloud-guanlan",
});

const grantOf = (authority = "account", accountId = "account-a", consumerId = "research") => {
  const authorization = managementGrantFromPrincipal(
    principal(accountId, consumerId),
    authority,
  );
  assert.equal(authorization.ok, true, JSON.stringify(authorization));
  return authorization.grant;
};

// Stands in for the future trusted server-side management policy. The scopes
// are test-only labels, not a claimed Cloud Auth contract.
const policy = {
  authorize(verifiedPrincipal) {
    const authority = verifiedPrincipal.scopes.includes("test:manage-account")
      ? "account"
      : verifiedPrincipal.scopes.includes("test:manage-consumer")
        ? "consumer"
        : null;
    if (authority === null) return { ok: false, failure: "not_authorized" };
    return managementGrantFromPrincipal(verifiedPrincipal, authority);
  },
};

const result = (results, changes) => ({
  success: true,
  results,
  meta: changes === undefined ? {} : { changes },
});

const fakeDb = ({ source = null, mutationResults, readResults, onBatch } = {}) => {
  const prepared = [];
  let batchCalls = 0;
  return {
    prepared,
    get batchCalls() {
      return batchCalls;
    },
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) {
          statement.values = values;
          return statement;
        },
        async first() {
          return source;
        },
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements) {
      batchCalls += 1;
      if (onBatch) return onBatch(batchCalls, statements);
      return batchCalls === 1 ? mutationResults : readResults;
    },
  };
};

const untouchedDb = () => ({
  prepare() {
    throw new Error("the database must not be touched");
  },
  batch() {
    throw new Error("the database must not be touched");
  },
});

const successfulAccountUpsert = () => fakeDb({
  source: { id: "src-approved", url: APPROVED },
  mutationResults: [
    result([], 1),
    result([{ accounts: 1, consumers: 1 }]),
    result([{ id: "src-approved", url: APPROVED }]),
    result([{ source_id: "src-approved", interval_hours: 4 }]),
  ],
  readResults: [
    result([{ accounts: 1, consumers: 1 }]),
    result([{ source_id: "src-approved", interval_hours: 4, level: "account" }]),
    result([]),
  ],
});

test("a management grant is only built from a usable verified principal and an explicit authority", () => {
  for (const authority of ["account", "consumer"]) {
    const authorization = managementGrantFromPrincipal(principal(), authority);
    assert.equal(authorization.ok, true);
    assert.equal(authorization.grant.authority, authority);
    assert.equal(authorization.grant.principal.accountId, "account-a");
  }

  assert.deepEqual(
    managementGrantFromPrincipal(principal(), "owner"),
    { ok: false, failure: "not_authorized" },
  );

  for (const [accountId, consumerId] of [
    ["", "research"],
    ["account-a", ""],
    [" account-a", "research"],
    ["account-a", "research "],
    ["a".repeat(129), "research"],
    [null, "research"],
    ["account-a", 7],
  ]) {
    assert.deepEqual(
      managementGrantFromPrincipal(principal(accountId, consumerId), "account"),
      { ok: false, failure: "invalid_principal" },
      `${accountId}/${consumerId}`,
    );
  }
});

test("read-only news authority never becomes management authority", () => {
  const readerPrincipal = principal("account-a", "research", ["guanlan.read"]);
  assert.deepEqual(policy.authorize(readerPrincipal), { ok: false, failure: "not_authorized" });

  const consumerManager = principal("account-a", "research", ["test:manage-consumer"]);
  const authorization = policy.authorize(consumerManager);
  assert.equal(authorization.ok, true);
  assert.equal(authorization.grant.authority, "consumer");
});

test("a plain principal or subject is not a management grant and is refused before D1", async () => {
  const mutator = createD1SubscriptionMutator(untouchedDb());
  const input = { level: "account", op: "upsert", sourceId: "src-approved", intervalHours: 1 };
  for (const candidate of [
    principal(),
    { accountId: "account-a", consumerId: "research" },
    null,
    {},
    { authority: "owner", principal: principal() },
    { authority: "account", principal: { ...principal(), accountId: 7 } },
  ]) {
    assert.deepEqual(await mutator.mutate(candidate, input), { ok: false, failure: "forbidden" });
  }
});

test("invalid mutation input is refused before D1", async () => {
  const mutator = createD1SubscriptionMutator(untouchedDb());
  const grant = grantOf("account");
  const bad = [
    null,
    [],
    "upsert",
    {},
    { level: "account", op: "upsert", sourceId: "src-approved" },
    { level: "account", op: "upsert", sourceId: "", intervalHours: 1 },
    { level: "account", op: "upsert", sourceId: 42, intervalHours: 1 },
    { level: "account", op: "upsert", sourceId: "src-approved", intervalHours: 0 },
    { level: "account", op: "upsert", sourceId: "src-approved", intervalHours: 25 },
    { level: "account", op: "upsert", sourceId: "src-approved", intervalHours: 1.5 },
    { level: "account", op: "upsert", sourceId: "src-approved", intervalHours: "1" },
    { level: "account", op: "replace", sourceId: "src-approved", intervalHours: 1 },
    { level: "team", op: "upsert", sourceId: "src-approved", intervalHours: 1 },
  ];
  for (const input of bad) {
    assert.deepEqual(await mutator.mutate(grant, input), { ok: false, failure: "invalid_input" },
      JSON.stringify(input));
  }
});

test("account and consumer management authorities are not interchangeable", async () => {
  const consumerGrant = grantOf("consumer");
  const accountGrant = grantOf("account");

  const consumerMutator = createD1SubscriptionMutator(untouchedDb());
  assert.deepEqual(
    await consumerMutator.mutate(consumerGrant, {
      level: "account", op: "upsert", sourceId: "src-approved", intervalHours: 1,
    }),
    { ok: false, failure: "forbidden" },
  );

  const accountMutator = createD1SubscriptionMutator(untouchedDb());
  assert.deepEqual(
    await accountMutator.mutate(accountGrant, {
      level: "consumer", op: "upsert", sourceId: "src-approved", intervalHours: 1,
    }),
    { ok: false, failure: "forbidden" },
  );
});

test("unknown and unapproved stored sources are refused without writing", async () => {
  const missing = fakeDb({ source: null });
  assert.deepEqual(
    await createD1SubscriptionMutator(missing).mutate(grantOf("account"), {
      level: "account", op: "upsert", sourceId: "missing", intervalHours: 1,
    }),
    { ok: false, failure: "source_not_found" },
  );
  assert.equal(missing.batchCalls, 0);

  const unapproved = fakeDb({ source: { id: "historical", url: UNAPPROVED } });
  assert.deepEqual(
    await createD1SubscriptionMutator(unapproved).mutate(grantOf("account"), {
      level: "account", op: "upsert", sourceId: "historical", intervalHours: 1,
    }),
    { ok: false, failure: "source_not_approved" },
  );
  assert.equal(unapproved.batchCalls, 0);
});

test("a successful account upsert reuses the GLN-006 effective view", async () => {
  const db = successfulAccountUpsert();
  const mutation = await createD1SubscriptionMutator(db).mutate(grantOf("account"), {
    level: "account", op: "upsert", sourceId: "src-approved", intervalHours: 4,
  });

  assert.equal(mutation.ok, true);
  assert.equal(mutation.changed, true);
  assert.equal(mutation.level, "account");
  assert.equal(mutation.intervalHours, 4);
  assert.deepEqual(mutation.effective.sourceIds, ["src-approved"]);
  assert.deepEqual(mutation.effective.sources, [
    { sourceId: "src-approved", origin: "account", intervalHours: 4, intervalSource: "account" },
  ]);
  // One pre-read, one transactional four-statement batch, one GLN-006 read.
  assert.equal(db.batchCalls, 2);
  assert.equal(db.prepared.length, 8);
});

test("the mutation DTO cannot select another account or consumer", async () => {
  const db = successfulAccountUpsert();
  await createD1SubscriptionMutator(db).mutate(grantOf("account"), {
    level: "account",
    op: "upsert",
    sourceId: "src-approved",
    intervalHours: 4,
    // A caller may try to smuggle identity; it is not part of the contract and
    // must never reach a bound parameter.
    accountId: "account-b",
    consumerId: "other",
  });
  const write = db.prepared[1];
  assert.match(write.sql.trim(), /^INSERT INTO guanlan_account_subscriptions\b/);
  assert.equal(write.values.includes("account-a"), true);
  assert.equal(write.values.includes("account-b"), false);
  assert.equal(write.values.includes("other"), false);
});

test("repeated identical upserts and removes are real no-ops", async () => {
  const sameInterval = fakeDb({
    source: { id: "src-approved", url: APPROVED },
    mutationResults: [
      result([], 0),
      result([{ accounts: 1, consumers: 1 }]),
      result([{ id: "src-approved", url: APPROVED }]),
      result([{ source_id: "src-approved", interval_hours: 4 }]),
    ],
    readResults: [
      result([{ accounts: 1, consumers: 1 }]),
      result([{ source_id: "src-approved", interval_hours: 4, level: "account" }]),
      result([]),
    ],
  });
  const unchanged = await createD1SubscriptionMutator(sameInterval).mutate(grantOf("account"), {
    level: "account", op: "upsert", sourceId: "src-approved", intervalHours: 4,
  });
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.changed, false);

  const absent = fakeDb({
    source: { id: "src-approved", url: APPROVED },
    mutationResults: [
      result([], 0),
      result([{ accounts: 1, consumers: 1 }]),
      result([{ id: "src-approved", url: APPROVED }]),
      result([]),
    ],
    readResults: [
      result([{ accounts: 1, consumers: 1 }]),
      result([]),
      result([]),
    ],
  });
  const removed = await createD1SubscriptionMutator(absent).mutate(grantOf("account"), {
    level: "account", op: "remove", sourceId: "src-approved",
  });
  assert.equal(removed.ok, true);
  assert.equal(removed.changed, false);
  assert.equal(removed.intervalHours, null);
  assert.deepEqual(removed.effective.sourceIds, []);
});

test("missing subjects are explicit denials, not storage failures", async () => {
  for (const [owner, failure] of [
    [{ accounts: 0, consumers: 0 }, "account_not_found"],
    [{ accounts: 1, consumers: 0 }, "consumer_not_found"],
  ]) {
    const db = fakeDb({
      source: { id: "src-approved", url: APPROVED },
      mutationResults: [
        result([], 0),
        result([owner]),
        result([{ id: "src-approved", url: APPROVED }]),
        result([]),
      ],
    });
    assert.deepEqual(
      await createD1SubscriptionMutator(db).mutate(grantOf("account"), {
        level: "account", op: "upsert", sourceId: "src-approved", intervalHours: 1,
      }),
      { ok: false, failure },
    );
  }
});

test("D1 failure and malformed batch results are storage failures, never success", async () => {
  const source = { id: "src-approved", url: APPROVED };

  const preReadFails = {
    prepare() {
      return {
        bind: () => ({ first: async () => { throw new Error("d1 unavailable"); } }),
      };
    },
  };
  await assert.rejects(
    createD1SubscriptionMutator(preReadFails).mutate(grantOf("account"), {
      level: "account", op: "upsert", sourceId: "src-approved", intervalHours: 1,
    }),
    error => error instanceof SubscriptionMutationError && error.code === "storage_failure",
  );

  const batchFails = fakeDb({ source, onBatch: async () => { throw new Error("d1 unavailable"); } });
  await assert.rejects(
    createD1SubscriptionMutator(batchFails).mutate(grantOf("account"), {
      level: "account", op: "upsert", sourceId: "src-approved", intervalHours: 1,
    }),
    error => error instanceof SubscriptionMutationError && error.code === "storage_failure",
  );

  for (const malformed of [
    [],
    [result([], 1), result([{ accounts: 1, consumers: 1 }])],
    [{ success: false, results: [], meta: { changes: 0 } },
      result([{ accounts: 1, consumers: 1 }]),
      result([{ id: "src-approved", url: APPROVED }]),
      result([])],
    [result([], 1), result([{ accounts: 1, consumers: 1 }]),
      result([{ id: "src-approved", url: APPROVED }]), result([])].map((entry, index) =>
      index === 0 ? { ...entry, meta: {} } : entry),
  ]) {
    const db = fakeDb({ source, mutationResults: malformed });
    await assert.rejects(
      createD1SubscriptionMutator(db).mutate(grantOf("account"), {
        level: "account", op: "upsert", sourceId: "src-approved", intervalHours: 1,
      }),
      error => error instanceof SubscriptionMutationError && error.code === "storage_failure",
    );
  }

  const postReadFails = fakeDb({
    source,
    mutationResults: [
      result([], 1),
      result([{ accounts: 1, consumers: 1 }]),
      result([{ id: "src-approved", url: APPROVED }]),
      result([{ source_id: "src-approved", interval_hours: 1 }]),
    ],
    onBatch: async call => {
      if (call === 1) {
        return [
          result([], 1),
          result([{ accounts: 1, consumers: 1 }]),
          result([{ id: "src-approved", url: APPROVED }]),
          result([{ source_id: "src-approved", interval_hours: 1 }]),
        ];
      }
      throw new Error("d1 unavailable");
    },
  });
  await assert.rejects(
    createD1SubscriptionMutator(postReadFails).mutate(grantOf("account"), {
      level: "account", op: "upsert", sourceId: "src-approved", intervalHours: 1,
    }),
    error => error instanceof SubscriptionMutationError && error.code === "storage_failure",
  );
});

test("the write batch only touches the two subscription tables", async () => {
  const db = successfulAccountUpsert();
  await createD1SubscriptionMutator(db).mutate(grantOf("account"), {
    level: "account", op: "upsert", sourceId: "src-approved", intervalHours: 4,
  });
  const mutationSql = db.prepared.slice(1, 5).map(statement => statement.sql);
  assert.match(mutationSql[0].trim(), /^INSERT INTO guanlan_account_subscriptions\b/);
  for (const sql of mutationSql) {
    assert.doesNotMatch(sql, /\b(UPDATE|REPLACE)\s+(poc_sources|poc_news)\b/i);
    assert.doesNotMatch(sql, /guanlan_(account|consumer)_interests|guanlan_consumer_news_states/);
    assert.doesNotMatch(sql, /\b(DROP|ALTER)\b/i);
  }
  // The source re-read is a SELECT; the mutation never writes the shared
  // collection table or the scheduler fields.
  assert.match(mutationSql[2].trim(), /^SELECT\b/i);
  assert.doesNotMatch(mutationSql.join("\n"), /poc_sources\s+SET|poc_sources\s*\(/i);
});
