import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchLimited } from "../dist/ingest.mjs";
import { rss } from "./fixtures.mjs";

// GLN-008 T1: the execution layer must reuse the same URL policy and must not
// let redirects, headers or a hostile response body escape its budget.

const APPROVED = "https://developers.cloudflare.com/changelog/rss/index.xml";
const encoder = new TextEncoder();

const streamOf = (chunks, { stall = false, onCancel } = {}) => new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    if (!stall) controller.close();
  },
  cancel() { onCancel?.(); },
});

test("an approved feed is fetched once, with manual redirects and the canonical URL", async () => {
  const seen = [];
  const body = rss(2);
  const text = await fetchLimited(APPROVED, async request => {
    seen.push(request);
    return new Response(body, { headers: { "content-type": "application/rss+xml" } });
  });
  assert.equal(text, body);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, APPROVED);
  assert.equal(seen[0].redirect, "manual");
  assert.match(seen[0].headers.get("accept"), /application\/rss\+xml/);
});

test("the fragment is canonicalized away before the request is built", async () => {
  let requested = "";
  await fetchLimited(`${APPROVED}#latest`, async request => {
    requested = request.url;
    return new Response(rss(1));
  });
  assert.equal(requested, APPROVED);
});

test("unsafe or unapproved URLs are rejected before the fetcher is called", async () => {
  const cases = [
    ["https://127.0.0.1/feed", "source_private_address"],
    ["https://[::1]/feed", "source_private_address"],
    ["https://example.com/rss.xml", "source_not_approved"],
    ["http://developers.cloudflare.com/changelog/rss/index.xml", "source_scheme_rejected"],
    ["https://user:pass@developers.cloudflare.com/changelog/rss/index.xml", "source_userinfo_rejected"],
    ["https://developers.cloudflare.com:8443/changelog/rss/index.xml", "source_port_rejected"],
    ["https://localhost/feed", "source_host_rejected"],
    ["not a url", "source_url_invalid"],
  ];
  for (const [url, reason] of cases) {
    let calls = 0;
    await assert.rejects(
      fetchLimited(url, async () => { calls++; return new Response(rss(1)); }),
      error => error.message === reason,
      url,
    );
    assert.equal(calls, 0, `${url} must not reach the network`);
  }
});

test("301, 302, 307 and 308 are errors, never followed", async () => {
  for (const status of [301, 302, 307, 308]) {
    let calls = 0;
    await assert.rejects(
      fetchLimited(APPROVED, async () => {
        calls++;
        return new Response(null, { status, headers: { location: "https://example.com/redirected" } });
      }),
      error => error.message === "unsupported_redirect",
      `status ${status}`,
    );
    assert.equal(calls, 1, `status ${status} must not follow Location`);
  }
});

test("upstream HTTP errors are classified without response content", async () => {
  for (const status of [400, 403, 404, 410, 500, 503]) {
    await assert.rejects(
      fetchLimited(APPROVED, async () => new Response("private upstream detail", { status })),
      error => error.message === `feed_http_${status}`,
    );
  }
});

test("a declared Content-Length over the limit is rejected", async () => {
  await assert.rejects(
    fetchLimited(APPROVED, async () => new Response(rss(1), { headers: { "content-length": "200000" } })),
    error => error.message === "feed_too_large",
  );
});

test("a missing Content-Length is still bounded by the streamed byte count", async () => {
  await assert.rejects(
    fetchLimited(APPROVED, async () => new Response(streamOf([new Uint8Array(200_000)]))),
    error => error.message === "feed_too_large",
  );
});

test("a lying or non-numeric Content-Length cannot bypass the streamed limit", async () => {
  for (const header of ["10", "not-a-number", "-1"]) {
    await assert.rejects(
      fetchLimited(APPROVED, async () => new Response(
        streamOf([new Uint8Array(200_000)]),
        { headers: { "content-length": header } },
      )),
      error => error.message === "feed_too_large",
      `content-length ${header}`,
    );
  }
});

test("a body that exceeds the limit mid-stream is rejected and the reader is cancelled", async () => {
  let cancelled = false;
  await assert.rejects(
    fetchLimited(APPROVED, async () => new Response(streamOf(
      [new Uint8Array(100_000), new Uint8Array(100_000)],
      { stall: true, onCancel: () => { cancelled = true; } },
    ))),
    error => error.message === "feed_too_large",
  );
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cancelled, true);
});

test("an empty response body is rejected", async () => {
  await assert.rejects(
    fetchLimited(APPROVED, async () => new Response(null)),
    error => error.message === "empty_body",
  );
});

test("a stalled response is aborted on the wall budget instead of hanging", async () => {
  const started = Date.now();
  await assert.rejects(
    fetchLimited(APPROVED, () => new Promise(() => {}), { timeoutMs: 30 }),
    error => error.message === "fetch_timeout",
  );
  assert.ok(Date.now() - started < 2_000);
});

test("a stalled body is aborted and its reader cancelled", async () => {
  let cancelled = false;
  const started = Date.now();
  await assert.rejects(
    fetchLimited(
      APPROVED,
      async () => new Response(streamOf([encoder.encode("<rss>")], {
        stall: true,
        onCancel: () => { cancelled = true; },
      })),
      { timeoutMs: 50 },
    ),
    error => error.message === "fetch_timeout",
  );
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cancelled, true);
  assert.ok(Date.now() - started < 2_000);
});

test("an abort from the fetcher propagates so the caller classifies it as a timeout", async () => {
  await assert.rejects(
    fetchLimited(APPROVED, async () => { throw new DOMException("aborted", "AbortError"); }),
    error => error.name === "AbortError",
  );
});

test("a 204 without a body is rejected rather than parsed as an empty feed", async () => {
  await assert.rejects(
    fetchLimited(APPROVED, async () => new Response(null, { status: 204 })),
    error => error.message === "empty_body",
  );
});
