/**
 * GLN-008 · maintainer-approved public feed allowlist.
 *
 * This file is the **only** configuration source for which external feed URLs
 * the collector may fetch. It is compiled into the Worker bundle, so there is
 * no database row, MCP tool argument, HTTP parameter or environment value that
 * can add an entry at runtime. Adding or removing a feed is a reviewed code
 * change; see `docs/engineering/gln-008-source-safety.md`.
 *
 * Why an allowlist instead of general URL validation:
 * the Workers `fetch()` API neither exposes nor pins the IP address that an
 * arbitrary third-party hostname resolves to. `resolveOverride` only takes
 * effect when both the URL host and the override host are inside the caller's
 * own Cloudflare zone, so it cannot be used to pin a public feed host to a
 * validated address. A URL-string check therefore cannot prove that an
 * approved-looking hostname will not later resolve to a loopback/private
 * address (DNS rebinding). Until the runtime can prove that property, unknown
 * hosts fail closed.
 *
 * Provenance: the entries below are the public feeds actually approved and
 * fetched by the isolated GLN-003 Cloudflare canary (Issue #6), recorded in
 * `docs/engineering/gln-003-cloudflare-canary.md`.
 */
export type ApprovedFeed = {
  /**
   * Exact canonical HTTPS URL. The collector compares normalized URLs, so this
   * value must be what `new URL(url).toString()` produces (lowercase scheme and
   * host, punycode host, default port removed, no fragment).
   */
  readonly url: string;
  /** Human-readable identity for review; never used for matching. */
  readonly label: string;
  /** Where the maintainer approval for this feed is recorded. */
  readonly approvedIn: string;
};

export const APPROVED_PUBLIC_FEEDS: readonly ApprovedFeed[] = Object.freeze([
  Object.freeze({
    url: "https://developers.cloudflare.com/changelog/rss/index.xml",
    label: "Cloudflare changelog RSS",
    approvedIn: "GLN-003 (Issue #6) isolated canary source",
  }),
  Object.freeze({
    url: "https://hnrss.org/newest?count=5",
    label: "Hacker News RSS (5 items)",
    approvedIn: "GLN-003 (Issue #6) isolated canary source",
  }),
  Object.freeze({
    url: "https://www.cloudflarestatus.com/history.atom",
    label: "Cloudflare status Atom",
    approvedIn: "GLN-003 (Issue #6) isolated canary source",
  }),
]);
