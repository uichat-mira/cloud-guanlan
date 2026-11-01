import { parseFeed } from "feedsmith";
import { XMLParser } from "fast-xml-parser";

export type NewsCandidate = { title: string; summary: string; url: string; publishedAt: string | null };
const MAX_ITEMS = 40;
// Keep only the article fields we actually persist. In particular, Atom
// <content> and publisher-specific metadata can be much larger than the
// title/summary/link set; do not construct those unused subtrees in JS.
// These elements are not consumed by the Guanlan news-index contract in RSS,
// Atom or RDF. Leave required link/title/summary/date elements untouched.
const UNUSED_XML_TAGS = new Set([
  "content", "content:encoded", "author", "contributor", "category", "rights",
  "guid", "id", "media:content", "media:group"
]);
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: false,
  trimValues: true,
  updateTag: tagName => UNUSED_XML_TAGS.has(tagName) ? false : tagName
});
const value = (input: unknown): string => {
  if (typeof input === "string" || typeof input === "number") return String(input).trim();
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    return value(record.value ?? record["#text"] ?? record.__cdata ?? "");
  }
  return "";
};
const items = (input: unknown): Record<string, unknown>[] => (Array.isArray(input) ? input : input ? [input] : []).filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
const cleanSummary = (raw: unknown): string => value(raw).replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
const asDate = (raw: unknown): string | null => {
  const v = value(raw);
  const d = v ? Date.parse(v) : NaN;
  return Number.isFinite(d) ? new Date(d).toISOString() : null;
};
/**
 * The single canonical-news-URL rule, shared by collection (`poc_news.url`) and
 * the consumer decision ledger (GLN-007). Any identity derived from an article
 * URL must use this function, otherwise the same article could be counted twice.
 *
 * `base` is the feed URL during collection; omitting it requires an absolute
 * URL, which is what a caller naming an already-stored article must provide.
 * The fragment is dropped, the query string is preserved (dropping arbitrary
 * parameters would merge distinct articles) and credentials are refused.
 */
export function canonicalNewsUrl(raw: unknown, base?: string): string | null {
  try {
    const candidate = value(raw);
    // new URL("", base) resolves to the *feed URL*, which is not a news article.
    if (!candidate) return null;
    const url = base === undefined ? new URL(candidate) : new URL(candidate, base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    // Preserve query string: removing arbitrary parameters can merge distinct articles.
    return url.toString();
  } catch { return null; }
}

const normalizeUrl = (raw: unknown, base: string): string | null => canonicalNewsUrl(raw, base);
const result = (entries: Array<{title: unknown; summary: unknown; url: unknown; date: unknown}>, base: string): NewsCandidate[] => {
  const unique = new Set<string>();
  return entries.slice(0, MAX_ITEMS).flatMap(item => {
    const url = normalizeUrl(item.url, base);
    const title = value(item.title);
    if (!url || !title || unique.has(url)) return [];
    unique.add(url);
    return [{title: title.slice(0, 500), summary: cleanSummary(item.summary), url, publishedAt: asDate(item.date)}];
  });
};
export function parseWithFeedsmith(input: string, source: string): NewsCandidate[] {
  const parsed = parseFeed(input, { maxItems: MAX_ITEMS });
  if (parsed.format === "rss") {
    return result((parsed.feed.items ?? []).map(i => ({title: i.title, summary: i.description, url: i.link, date: i.pubDate})), source);
  }
  if (parsed.format === "rdf") {
    return result((parsed.feed.items ?? []).map(i => ({title: i.title, summary: i.description, url: i.link, date: null})), source);
  }
  if (parsed.format === "atom") {
    return result((parsed.feed.entries ?? []).map(i => ({
      title: i.title, summary: i.summary, url: i.links?.find(link => !link.rel || link.rel === "alternate")?.href,
      date: i.published ?? i.updated
    })), source);
  }
  // JSON Feed is supported by Feedsmith but not a GLN-001 acceptance requirement.
  throw new Error("GLN-001 accepts RSS, RDF and Atom only");
}
export function parseWithFastXml(input: string, source: string): NewsCandidate[] {
  const doc = xmlParser.parse(input);
  if (doc.rss?.channel || doc["rdf:RDF"]) {
    const channel = doc.rss?.channel ?? doc["rdf:RDF"];
    const entries = items(channel.item ?? doc["rdf:RDF"]?.item);
    return result(entries.map(i => ({title:i.title, summary:i.description, url:i.link, date:i.pubDate ?? i["dc:date"]})), source);
  }
  if (doc.feed) {
    return result(items(doc.feed.entry).map(i => {
      const links = items(i.link);
      const link = links.find(x => !x["@_rel"] || x["@_rel"] === "alternate");
      return {title:i.title, summary:i.summary, url:link?.["@_href"], date:i.published ?? i.updated};
    }), source);
  }
  throw new Error("Unsupported RSS/Atom XML");
}
