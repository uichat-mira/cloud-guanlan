import { APPROVED_PUBLIC_FEEDS, type ApprovedFeed } from "./source-allowlist";

export { APPROVED_PUBLIC_FEEDS };
export type { ApprovedFeed };

/**
 * GLN-008 · pure, fail-closed safety policy for untrusted RSS/Atom source URLs.
 *
 * This module is the single URL decision point reused by both the collection
 * path (`src/ingest.ts:fetchLimited`) and the controlled source registry
 * (`src/source-registry.ts`). It performs **no I/O** and never touches D1, so
 * the same decision is applied before a request is created and before a source
 * row is written.
 *
 * What this layer does prove:
 * - the string is an unambiguous, canonical HTTPS URL on an explicitly approved
 *   public feed URL, with no userinfo, no non-443 port, no trailing-dot host,
 *   no IP literal and no special-use/local hostname;
 * - the exact approved URL (not just an approved host) is fetched, so a path or
 *   query change cannot silently select a different resource.
 *
 * What this layer does **not** prove: that the approved hostname resolves to a
 * public IP at fetch time. Workers cannot observe or pin the resolved address
 * for an arbitrary host, so this is a controlled-admission gate, not a general
 * SSRF proof. See `docs/engineering/gln-008-source-safety.md`.
 */

export type SourceRejectionReason =
  | "source_url_invalid"
  | "source_scheme_rejected"
  | "source_userinfo_rejected"
  | "source_host_rejected"
  | "source_private_address"
  | "source_ip_literal_rejected"
  | "source_port_rejected"
  | "source_not_approved";

export type SourcePolicyDecision =
  | { readonly ok: true; readonly canonicalUrl: string; readonly feed: ApprovedFeed }
  | { readonly ok: false; readonly reason: SourceRejectionReason };

/** Defensive bound; approved feed URLs are far shorter. */
const MAX_SOURCE_URL_LENGTH = 2048;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Single-label hosts are never public news feeds. These suffixes are IANA
 * special-use names, private DNS suffixes or names that resolve on local
 * networks; all of them are rejected regardless of the allowlist.
 */
const SPECIAL_USE_HOST_SUFFIXES = Object.freeze([
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".corp",
  ".private",
  ".arpa",
  ".test",
  ".invalid",
  ".example",
  ".onion",
  ".alt",
]);
const SPECIAL_USE_HOSTS = new Set(["localhost"]);

const reject = (reason: SourceRejectionReason): SourcePolicyDecision => ({ ok: false, reason });

/**
 * The raw authority is needed because the WHATWG URL parser discards an empty
 * userinfo (`https://@host/` keeps no username) while the raw string is still
 * ambiguous. Only the segment between the scheme and the first path/query/
 * fragment separator is inspected, so `@` in a path or query is not rejected.
 */
const rawAuthority = (input: string): string => {
  const afterScheme = input.slice(input.indexOf(":") + 1);
  // Skip the `//` (or backslashes, which the WHATWG parser treats as slashes
  // for special schemes) before the authority.
  const authorityStart = afterScheme.search(/[^/\\]/);
  if (authorityStart === -1) return "";
  const rest = afterScheme.slice(authorityStart);
  const end = rest.search(/[/?#\\]/);
  return end === -1 ? rest : rest.slice(0, end);
};

const parseIpv4 = (hostname: string): readonly number[] | null => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every(octet => octet <= 255) ? octets : null;
};

/**
 * Non-public IPv4 space. `a >= 224` covers multicast (224/4) and reserved
 * (240/4, including 255.255.255.255); the remaining entries are the ranges the
 * policy treats as loopback/private/link-local/CGNAT/documentation/reserved.
 */
const isNonPublicIpv4 = (octets: readonly number[]): boolean => {
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
};

/** Parses a bracketed-IPv6 literal body into eight 16-bit groups, or null. */
const parseIpv6 = (literal: string): readonly number[] | null => {
  // A zone identifier (`%eth0`) is link-local scoping syntax, not a plain
  // literal; fail closed rather than guess.
  if (literal.includes("%")) return null;
  const halves = literal.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (part: string): readonly number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      if (group.includes(".")) {
        // Embedded IPv4 is only valid as the final group.
        if (index !== groups.length - 1) return null;
        const ipv4 = parseIpv4(group);
        if (!ipv4) return null;
        out.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  const head = parseGroups(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parseGroups(halves[1]);
  if (!tail) return null;
  const zeros = 8 - head.length - tail.length;
  if (zeros < 1) return null;
  return [...head, ...new Array<number>(zeros).fill(0), ...tail];
};

/**
 * Non-public IPv6 space. IPv4-mapped and IPv4-compatible addresses delegate to
 * the IPv4 classification of their embedded address; NAT64 and 6to4 are treated
 * as non-public translation prefixes.
 */
const isNonPublicIpv6 = (groups: readonly number[]): boolean => {
  if (groups.every(group => group === 0)) return true; // ::/128 unspecified
  if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return true; // ::1/128 loopback
  const embeddedIpv4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return isNonPublicIpv4(embeddedIpv4); // ::ffff:0:0/96 IPv4-mapped
  }
  if (groups.slice(0, 6).every(group => group === 0)) return true; // ::/96 IPv4-compatible (deprecated)
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x2001 && groups[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (first === 0x2001 && groups[1] === 0x0000) return true; // 2001::/32 Teredo
  if (first === 0x2002) return true; // 2002::/16 6to4
  if (first === 0x0064 && groups[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64
  return false;
};

/**
 * Every IP literal is rejected; the private/public split only chooses a
 * diagnostic code. The WHATWG parser normalizes decimal, octal, hex and
 * shorthand IPv4 forms to dotted decimal before this check, so those
 * obfuscations cannot slip through as hostnames.
 */
const classifyIpLiteral = (hostname: string): SourceRejectionReason | null => {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const groups = parseIpv6(hostname.slice(1, -1));
    if (!groups) return "source_host_rejected";
    return isNonPublicIpv6(groups) ? "source_private_address" : "source_ip_literal_rejected";
  }
  const ipv4 = parseIpv4(hostname);
  if (ipv4) return isNonPublicIpv4(ipv4) ? "source_private_address" : "source_ip_literal_rejected";
  // An all-numeric host that is not a valid IPv4 literal is malformed or an
  // ambiguous address spelling; reject instead of guessing.
  if (/^[0-9.]+$/.test(hostname)) return "source_host_rejected";
  return null;
};

/**
 * Decides whether one untrusted string may be used as a feed URL.
 *
 * Fail-closed rules, in order: bounded string, parseable absolute URL, HTTPS
 * only, no userinfo, port 443 only, canonical non-special-use host, no IP
 * literal, no trailing-dot host, and finally an exact match against the
 * approved feed allowlist. A fragment is removed during canonicalization
 * because it is never sent to the origin.
 */
export function evaluateSourceUrl(
  input: unknown,
  feeds: readonly ApprovedFeed[] = APPROVED_PUBLIC_FEEDS,
): SourcePolicyDecision {
  if (typeof input !== "string") return reject("source_url_invalid");
  if (input.length === 0 || input.length > MAX_SOURCE_URL_LENGTH) return reject("source_url_invalid");
  // Reject instead of silently trimming: surrounding whitespace/control bytes
  // are exactly the kind of ambiguity this gate must not normalize away.
  if (input !== input.trim()) return reject("source_url_invalid");
  if (CONTROL_CHARACTERS.test(input)) return reject("source_url_invalid");

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return reject("source_url_invalid");
  }

  if (url.protocol !== "https:") return reject("source_scheme_rejected");
  if (url.username !== "" || url.password !== "" || rawAuthority(input).includes("@")) {
    return reject("source_userinfo_rejected");
  }
  // The parser removes an explicit `:443`, so any remaining port is non-default.
  if (url.port !== "") return reject("source_port_rejected");

  const hostname = url.hostname;
  if (hostname.length === 0 || hostname.length > 253) return reject("source_host_rejected");
  // `example.com.` and `example.com` are the same DNS name but different
  // strings; refuse the ambiguity instead of normalizing it.
  if (hostname.endsWith(".")) return reject("source_host_rejected");
  const literalReason = classifyIpLiteral(hostname);
  if (literalReason) return reject(literalReason);
  if (!hostname.includes(".")) return reject("source_host_rejected");
  if (
    SPECIAL_USE_HOSTS.has(hostname) ||
    SPECIAL_USE_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix))
  ) {
    return reject("source_host_rejected");
  }

  url.hash = "";
  const canonicalUrl = url.toString();
  const feed = feeds.find(entry => entry.url === canonicalUrl);
  if (!feed) return reject("source_not_approved");
  return { ok: true, canonicalUrl, feed };
}
