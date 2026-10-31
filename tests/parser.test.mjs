import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWithFastXml,parseWithFeedsmith } from "../dist/parser.mjs";
import { rss,atom } from "./fixtures.mjs";
const parsers = [parseWithFastXml, parseWithFeedsmith];
for(const parse of parsers) {
  test(`${parse.name} reads bounded RSS and Atom without storing full text`,()=>{
    const r = parse(rss(3),"https://example.com/rss.xml");
    assert.equal(r.length,3);
    assert.equal(r[0].title,"Story 0");
    assert.equal(r[0].summary,"Short summary 0");
    assert.equal(r[0].url,"https://example.com/story/0?lang=en");
    const a = parse(atom,"https://example.com/atom.xml");
    assert.equal(a.length,1);
    assert.equal(a[0].url,"https://example.com/atom/1");
    assert.equal(a[0].title,"Atom story");
    assert.equal(a[0].summary,"Atom short summary");
    assert.equal(parse(rss(120),"https://example.com/rss.xml").length,40);
  });
  test(`${parse.name} rejects invalid input and avoids arbitrary URLs`,()=>{
    assert.throws(()=>parse("<html>invalid</html>","https://example.com/feed.xml"));
    const poisoned=rss(1).replace("https://example.com/story/0?lang=en","javascript:alert(1)");
    assert.equal(parse(poisoned,"https://example.com/feed.xml").length,0);
  });
  test(`${parse.name} only uses Atom alternate/default article links`,()=>{
    const onlySelf = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Test</title><id>urn:feed:one</id><updated>2026-10-31T00:00:00Z</updated>
        <entry><id>urn:1</id><title>No article URL</title><updated>2026-10-31T00:00:00Z</updated>
          <link rel="self" href="https://example.com/metadata/1" /></entry>
      </feed>`;
    assert.equal(parse(onlySelf,"https://example.com/atom.xml").length,0,
      "Atom self link is metadata, not the article URL");
    const withAlternate = onlySelf.replace(
      '<link rel="self" href="https://example.com/metadata/1" />',
      '<link rel="self" href="https://example.com/metadata/1" /><link rel="alternate" href="https://example.com/story/1" />'
    );
    const result = parse(withAlternate,"https://example.com/atom.xml");
    assert.equal(result.length,1);
    assert.equal(result[0].url,"https://example.com/story/1");
  });

}
