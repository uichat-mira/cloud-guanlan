import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVED_PUBLIC_FEEDS, evaluateSourceUrl } from "../dist/source-safety.mjs";

// GLN-008 T1: the pure URL policy must fail closed for every untrusted input.
// The policy is shared by the network path (fetchLimited) and the source
// registry, so these decisions are the acceptance matrix for both.

const accept = (input) => {
  const decision = evaluateSourceUrl(input);
  assert.equal(decision.ok, true, `expected accepted, got ${decision.reason} for ${JSON.stringify(input)}`);
  return decision;
};
const reject = (input, reason) => {
  const decision = evaluateSourceUrl(input);
  assert.equal(decision.ok, false, `expected rejected for ${JSON.stringify(input)}`);
  assert.equal(decision.reason, reason, `wrong reason for ${JSON.stringify(input)}`);
  return decision;
};

test("every maintainer-approved public feed is accepted and already canonical", () => {
  assert.ok(APPROVED_PUBLIC_FEEDS.length > 0);
  for (const feed of APPROVED_PUBLIC_FEEDS) {
    assert.equal(new URL(feed.url).toString(), feed.url, `${feed.url} is not a canonical URL`);
    const decision = accept(feed.url);
    assert.equal(decision.canonicalUrl, feed.url);
    assert.equal(decision.feed.url, feed.url);
  }
});

test("case, default port and fragment are canonicalized, never treated as a new source", () => {
  const decision = accept("HTTPS://WWW.CloudflareStatus.COM:443/history.atom#latest");
  assert.equal(decision.canonicalUrl, "https://www.cloudflarestatus.com/history.atom");
  assert.equal(decision.feed.url, "https://www.cloudflarestatus.com/history.atom");
});

test("only https is accepted; every other scheme is rejected before any host check", () => {
  for (const input of [
    "http://developers.cloudflare.com/changelog/rss/index.xml",
    "ftp://developers.cloudflare.com/changelog/rss/index.xml",
    "file:///etc/passwd",
    "data:text/xml,<rss/>",
    "javascript:alert(1)",
    "ws://developers.cloudflare.com/feed",
    "wss://developers.cloudflare.com/feed",
    "gopher://developers.cloudflare.com/feed",
  ]) {
    reject(input, "source_scheme_rejected");
  }
  reject("//developers.cloudflare.com/changelog/rss/index.xml", "source_url_invalid");
  reject("/changelog/rss/index.xml", "source_url_invalid");
});

test("userinfo is rejected even when the URL parser would discard it", () => {
  for (const input of [
    "https://user:password@developers.cloudflare.com/changelog/rss/index.xml",
    "https://user@developers.cloudflare.com/changelog/rss/index.xml",
    "https://@developers.cloudflare.com/changelog/rss/index.xml",
    "https://user%40name@developers.cloudflare.com/changelog/rss/index.xml",
    "https://:password@developers.cloudflare.com/changelog/rss/index.xml",
  ]) {
    reject(input, "source_userinfo_rejected");
  }
});

test("localhost, single-label and special-use hostnames are rejected", () => {
  for (const input of [
    "https://localhost/feed",
    "https://LOCALHOST/feed",
    "https://foo.localhost/feed",
    "https://printer.local/feed",
    "https://metadata.google.internal/feed",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://foo.home.arpa/feed",
    "https://foo.intranet/feed",
    "https://foo.lan/feed",
    "https://foo.corp/feed",
    "https://foo.private/feed",
    "https://foo.localdomain/feed",
    "https://feed.test/",
    "https://feed.invalid/",
    "https://feed.example/",
    "https://abcdef.onion/",
    "https://intranet/feed",
  ]) {
    reject(input, "source_host_rejected");
  }
});

test("private, reserved, loopback and link-local IPv4 literals are rejected", () => {
  for (const host of [
    "127.0.0.1", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255",
    "192.168.0.1", "169.254.169.254", "100.64.0.1", "100.127.255.255",
    "0.0.0.0", "224.0.0.1", "239.255.255.250", "255.255.255.255",
    "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9",
    "192.0.2.1", "192.0.0.8", "240.0.0.1",
  ]) {
    reject(`https://${host}/feed`, "source_private_address");
  }
});

test("obfuscated IPv4 spellings are normalized by the URL parser and still rejected", () => {
  for (const input of [
    "https://127.1/feed",
    "https://2130706433/feed",
    "https://0x7f000001/feed",
    "https://0177.0.0.1/feed",
  ]) {
    reject(input, "source_private_address");
  }
});

test("public IP literals are rejected as literals, not treated as hostnames", () => {
  for (const input of ["https://8.8.8.8/feed", "https://1.1.1.1/feed", "https://172.32.0.1/feed"]) {
    reject(input, "source_ip_literal_rejected");
  }
});

test("IPv6 literals are rejected, including mapped, link-local and reserved ranges", () => {
  for (const input of [
    "https://[::1]/feed",
    "https://[::]/feed",
    "https://[fe80::1]/feed",
    "https://[fc00::1]/feed",
    "https://[fd12:3456:789a::1]/feed",
    "https://[ff02::1]/feed",
    "https://[::ffff:127.0.0.1]/feed",
    "https://[::ffff:10.0.0.1]/feed",
    "https://[2001:db8::1]/feed",
    "https://[2002::1]/feed",
    "https://[64:ff9b::1.1.1.1]/feed",
  ]) {
    reject(input, "source_private_address");
  }
  for (const input of ["https://[2606:4700::1111]/feed", "https://[::ffff:8.8.8.8]/feed"]) {
    reject(input, "source_ip_literal_rejected");
  }
});

test("non-default ports are rejected while an explicit 443 is canonicalized away", () => {
  for (const port of ["80", "8080", "8443", "3000", "4433"]) {
    reject(`https://developers.cloudflare.com:${port}/changelog/rss/index.xml`, "source_port_rejected");
  }
  accept("https://developers.cloudflare.com:443/changelog/rss/index.xml");
});

test("trailing-dot hostnames are rejected instead of silently normalized", () => {
  reject("https://developers.cloudflare.com./changelog/rss/index.xml", "source_host_rejected");
  reject("https://www.cloudflarestatus.com./history.atom", "source_host_rejected");
});

test("unapproved hosts, paths and queries fail closed", () => {
  for (const input of [
    "https://example.com/rss.xml",
    "https://evil.example.com/feed",
    "https://developers.cloudflare.com/changelog/rss/other.xml",
    "https://developers.cloudflare.com/changelog/rss/index.xml?x=1",
    "https://developers.cloudflare.com/changelog/rss/index.xml/",
    "https://www.cloudflarestatus.com/history.atom?",
    "https://hnrss.org/newest",
    "https://hnrss.org/newest?count=6",
    "https://hnrss.org/newest?count=5&x=1",
    "https://sub.developers.cloudflare.com/changelog/rss/index.xml",
  ]) {
    reject(input, "source_not_approved");
  }
});

test("IDN and homograph spellings cannot impersonate an approved host", () => {
  // The parser converts IDN to punycode; the result is simply not approved.
  for (const input of [
    "https://bücher.de/feed",
    "https://exаmple.com/feed", // Cyrillic 'а' in "example"
    "https://xn--exmple-4nf.com/feed",
    "https://developers.cloudflare.com.attacker.dev/changelog/rss/index.xml",
  ]) {
    reject(input, "source_not_approved");
  }
  // Fullwidth full stops are IDN dots, not a bypass: they canonicalize to the
  // same approved host and are therefore the same source.
  const decision = accept("https://developers。cloudflare。com/changelog/rss/index.xml");
  assert.equal(decision.canonicalUrl, "https://developers.cloudflare.com/changelog/rss/index.xml");
});

test("malformed or ambiguous input is rejected instead of guessed", () => {
  for (const input of [
    "",
    "   ",
    " https://developers.cloudflare.com/changelog/rss/index.xml",
    "https://developers.cloudflare.com/changelog/rss/index.xml ",
    "https://developers.cloudflare.com/changelog/rss/index.xml\n",
    "https://developers.cloudflare.com/changelog/rss/\u0000index.xml",
    "not a url",
    "https://",
    "https://999.1.1.1/feed",
    "https://" + "a".repeat(3000) + "/feed",
  ]) {
    reject(input, "source_url_invalid");
  }
  // The parser accepts this with an empty host; the host policy still rejects.
  reject("https:///feed", "source_host_rejected");
  for (const input of [null, undefined, 42, {}, [], true]) {
    reject(input, "source_url_invalid");
  }
});

test("rejection reasons are closed safe enums that never echo the input", () => {
  const inputs = [
    "https://127.0.0.1/secret-feed",
    "https://user:token@developers.cloudflare.com/private",
    "https://example.com/private?token=abc",
    "http://internal.corp/feed",
  ];
  for (const input of inputs) {
    const decision = evaluateSourceUrl(input);
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /^source_[a-z_]+$/);
    assert.equal(JSON.stringify(decision).includes("token"), false);
    assert.equal(JSON.stringify(decision).includes("secret-feed"), false);
    assert.equal(JSON.stringify(decision).includes("127.0.0.1"), false);
  }
});
