export const rss = (n = 2) => `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Example News</title><link>https://example.com</link><description>Fixture</description>
${Array.from({length:n},(_,i)=>`<item><title>Story ${i}</title><link>https://example.com/story/${i}?lang=en</link><description>Short summary ${i}</description><pubDate>Fri, 30 Oct 2026 00:00:00 GMT</pubDate></item>`).join("")}
</channel></rss>`;
export const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Example Atom</title><id>urn:feed:test</id><updated>2026-10-30T00:00:00Z</updated>
<entry><id>urn:item:1</id><title>Atom story</title><updated>2026-10-30T00:00:00Z</updated><link href="https://example.com/atom/1"/><summary>Atom short summary</summary></entry></feed>`;
