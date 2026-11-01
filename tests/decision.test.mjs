import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DECIDE_INPUT_SCHEMA,
  DECIDE_OPERATION_ID_MAX,
  DECIDE_REASON_MAX,
  DECIDE_STATUS_VALUES,
  DECIDE_TOOL_ERRORS,
  GUANLAN_WRITE_SCOPE,
  NEWS_ITEM_SCHEMA,
  NewsReadError,
  WRITE_ANNOTATIONS,
  createNewsDecider,
  hasWriteScope,
  renderDecisionMarkdown,
} from "../dist/decision-unit.mjs";

// GLN-010 T1/T2: the MCP write contract. The decider is a thin adapter over the
// GLN-007 ledger, so these tests prove schema bounds, identity provenance, the
// outcome taxonomy and the write-scope boundary. Real D1/CAS/restart evidence is
// in decision-workerd.test.mjs.

const principal = (scopes = ["guanlan.read", GUANLAN_WRITE_SCOPE]) => ({
  accountId: "account-a",
  consumerId: "consumer-1",
  scopes,
  expiresAt: 4_102_444_800,
  issuer: "mira:cloud-auth",
  audience: "mira:cloud-guanlan",
});

const state = (status = "adopted", version = 1, extra = {}) => ({
  url: "https://example.com/story",
  fingerprint: "0".repeat(64),
  sourceId: "feed-1",
  status,
  version,
  reason: null,
  outcomeUrl: null,
  decidedAt: "2026-11-01T00:00:00.000Z",
  ...extra,
});

const request = (extra = {}) => ({
  url: "https://example.com/story",
  status: "adopted",
  expectedVersion: 0,
  operationId: "op-1",
  ...extra,
});

/** Ledger double: records the exact call and returns a scripted result. */
const fakeLedger = (result) => {
  const calls = [];
  return {
    calls,
    async read() {
      throw new Error("the write adapter must never read the ledger");
    },
    async write(subject, writeRequest) {
      calls.push({ subject, request: writeRequest });
      if (result instanceof Error) throw result;
      return result;
    },
  };
};

test("the write input schema is bounded and has no identity-selecting field", () => {
  assert.equal(DECIDE_INPUT_SCHEMA.safeParse(request()).success, true);
  assert.equal(
    DECIDE_INPUT_SCHEMA.safeParse(request({ reason: "why", outcomeUrl: "https://example.com/out" })).success,
    true,
  );
  assert.deepEqual(DECIDE_STATUS_VALUES, ["pending", "adopted", "ignored"]);

  for (const invalid of [
    {},
    request({ url: "" }),
    request({ status: "unread" }),
    request({ status: "bogus" }),
    request({ expectedVersion: -1 }),
    request({ expectedVersion: 1.5 }),
    request({ operationId: "" }),
    request({ operationId: "x".repeat(DECIDE_OPERATION_ID_MAX + 1) }),
    request({ reason: "x".repeat(DECIDE_REASON_MAX + 1) }),
    request({ outcomeUrl: "x".repeat(2_049) }),
  ]) {
    assert.equal(DECIDE_INPUT_SCHEMA.safeParse(invalid).success, false, JSON.stringify(invalid));
  }

  // A model-supplied account/consumer is not part of the contract. Zod strips
  // unknown keys, and the decider only ever receives the verified principal.
  const parsed = DECIDE_INPUT_SCHEMA.safeParse(request({ accountId: "account-b", consumerId: "consumer-b" }));
  assert.equal(parsed.success, true);
  assert.deepEqual(Object.keys(parsed.data).sort(), ["expectedVersion", "operationId", "status", "url"]);
  assert.equal("accountId" in parsed.data, false);
  assert.equal("consumerId" in parsed.data, false);
});

test("the write tool is annotated as a write, not as read-only", () => {
  assert.equal(WRITE_ANNOTATIONS.readOnlyHint, false);
  assert.equal(WRITE_ANNOTATIONS.destructiveHint, false);
  assert.equal(WRITE_ANNOTATIONS.idempotentHint, true);
  assert.equal(WRITE_ANNOTATIONS.openWorldHint, false);
});

test("the read page schema requires a non-negative stateVersion", () => {
  const item = {
    id: "https://example.com/story",
    title: "Title",
    summary: "Summary",
    url: "https://example.com/story",
    sourceId: "feed-1",
    publishedAt: null,
    ingestedAt: "2026-11-01T00:00:00.000Z",
    status: "unread",
    stateVersion: 0,
  };
  assert.equal(NEWS_ITEM_SCHEMA.safeParse(item).success, true);
  assert.equal(NEWS_ITEM_SCHEMA.safeParse({ ...item, stateVersion: 1 }).success, true);
  assert.equal(NEWS_ITEM_SCHEMA.safeParse({ ...item, stateVersion: -1 }).success, false);
  assert.equal(NEWS_ITEM_SCHEMA.safeParse({ ...item, stateVersion: 1.5 }).success, false);
  const { stateVersion, ...withoutVersion } = item;
  assert.equal(stateVersion, 0);
  assert.equal(NEWS_ITEM_SCHEMA.safeParse(withoutVersion).success, false);
});

test("the write scope is independent and never implied by read authority", () => {
  assert.equal(GUANLAN_WRITE_SCOPE, "guanlan.write");
  assert.equal(hasWriteScope(["guanlan.read"]), false);
  assert.equal(hasWriteScope([]), false);
  assert.equal(hasWriteScope(["guanlan.read", GUANLAN_WRITE_SCOPE]), true);
  assert.equal(hasWriteScope(["guanlan.write.extra"]), false);
  assert.equal(hasWriteScope(["GUANLAN.WRITE"]), false);
});

test("the decider forwards the verified subject and reports updated/replayed", async () => {
  const ledger = fakeLedger({ ok: true, result: "updated", state: state("adopted", 1) });
  const decider = createNewsDecider(ledger);
  const outcome = await decider.decide(principal(), request({ reason: "because", outcomeUrl: "https://example.com/out" }));

  assert.equal(outcome.ok, true);
  assert.equal(outcome.result, "updated");
  assert.equal(outcome.state.version, 1);
  assert.equal(outcome.state.status, "adopted");
  assert.equal(ledger.calls.length, 1);
  assert.deepEqual(ledger.calls[0].subject, { accountId: "account-a", consumerId: "consumer-1" });
  assert.deepEqual(ledger.calls[0].request, {
    url: "https://example.com/story",
    status: "adopted",
    expectedVersion: 0,
    operationId: "op-1",
    reason: "because",
    outcomeUrl: "https://example.com/out",
  });

  const replayed = createNewsDecider(fakeLedger({ ok: true, result: "replayed", state: state("adopted", 1) }));
  const replayOutcome = await replayed.decide(principal(), request());
  assert.equal(replayOutcome.ok, true);
  assert.equal(replayOutcome.result, "replayed");
});

test("unknown article and unauthorized source collapse to one opaque not_available", async () => {
  for (const failure of ["news_not_found", "source_not_authorized"]) {
    const outcome = await createNewsDecider(fakeLedger({ ok: false, failure }))
      .decide(principal(), request());
    assert.deepEqual(outcome, { ok: false, failure: "not_available" });
  }
  // The MCP-facing error code is one code, so the text cannot distinguish the two.
  assert.equal(DECIDE_TOOL_ERRORS.notAvailable, "guanlan_decision_not_available");
});

test("conflicts preserve the bounded current decision and never become success", async () => {
  for (const failure of ["version_conflict", "operation_conflict"]) {
    const current = state("ignored", 3, { reason: "kept", decidedAt: "2026-11-02T00:00:00.000Z" });
    const outcome = await createNewsDecider(fakeLedger({ ok: false, failure, current }))
      .decide(principal(), request());
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failure, failure);
    assert.equal(outcome.current.version, 3);
    assert.equal(outcome.current.status, "ignored");
  }

  // A conflict without current truth is a storage anomaly, not a business answer.
  await assert.rejects(
    createNewsDecider(fakeLedger({ ok: false, failure: "version_conflict" })).decide(principal(), request()),
    error => error.name === "ConsumptionLedgerError" && error.code === "storage_failure",
  );
});

test("provisioning and invalid-request failures stay explicit; storage failures propagate", async () => {
  for (const failure of ["account_not_found", "consumer_not_found", "invalid_subject"]) {
    const outcome = await createNewsDecider(fakeLedger({ ok: false, failure }))
      .decide(principal(), request());
    assert.deepEqual(outcome, { ok: false, failure: "principal_unavailable" });
  }
  const invalid = await createNewsDecider(fakeLedger({ ok: false, failure: "invalid_request" }))
    .decide(principal(), request());
  assert.deepEqual(invalid, { ok: false, failure: "invalid_request" });

  // The ledger's storage failure is never folded into a denial or a conflict.
  await assert.rejects(
    createNewsDecider(fakeLedger(new Error("d1 down"))).decide(principal(), request()),
    /d1 down/,
  );
});

test("an unusable verified principal is refused before the ledger is touched", async () => {
  const ledger = fakeLedger({ ok: true, result: "updated", state: state() });
  const outcome = await createNewsDecider(ledger).decide(
    { ...principal(), accountId: "" },
    request(),
  );
  assert.deepEqual(outcome, { ok: false, failure: "principal_unavailable" });
  assert.equal(ledger.calls.length, 0);
});

test("a stored decision that claims to be unread is a storage anomaly", async () => {
  await assert.rejects(
    createNewsDecider(fakeLedger({ ok: true, result: "updated", state: state("unread", 0) }))
      .decide(principal(), request()),
    error => error.name === "ConsumptionLedgerError" && error.code === "storage_failure",
  );
});

test("the success Markdown is rendered from the same result as structuredContent", () => {
  const result = {
    result: "updated",
    state: {
      url: "https://example.com/story",
      status: "adopted",
      version: 2,
      sourceId: "feed-1",
      reason: "because",
      outcomeUrl: "https://example.com/out",
      decidedAt: "2026-11-01T00:00:00.000Z",
    },
  };
  const markdown = renderDecisionMarkdown(result);
  assert.match(markdown, /# Cloud Guanlan decision · updated/);
  assert.match(markdown, /Status: adopted/);
  assert.match(markdown, /Version: 2/);
  assert.match(markdown, /URL: https:\/\/example\.com\/story/);
  assert.match(markdown, /Reason: because/);
  assert.match(markdown, /Outcome: https:\/\/example\.com\/out/);
});

test("the read failure taxonomy is unchanged by the write adapter", () => {
  // A guard against accidentally reusing the read error codes for decisions.
  const error = new NewsReadError("storage_failure", "boom");
  assert.equal(error.code, "storage_failure");
  assert.notEqual(DECIDE_TOOL_ERRORS.unavailable, "guanlan_news_unavailable");
  assert.equal(DECIDE_TOOL_ERRORS.unavailable, "guanlan_decision_unavailable");
});
