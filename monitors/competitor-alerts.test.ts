import { describe, expect, it } from 'vitest';

import { parseRss } from './competitor-alerts.js';

describe('parseRss', () => {
  it('returns 3 items from well-formed RSS with CDATA and plain titles', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title><![CDATA[  First Article  ]]></title>
      <link>https://example.com/1</link>
      <guid>guid-1</guid>
      <pubDate>Mon, 01 Jan 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Second Article</title>
      <link>https://example.com/2</link>
      <guid>guid-2</guid>
      <pubDate>Tue, 02 Jan 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title><![CDATA[Third Article]]></title>
      <link>https://example.com/3</link>
      <guid>guid-3</guid>
      <pubDate>Wed, 03 Jan 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;
    const result = parseRss(xml);
    expect(result).toHaveLength(3);
  });

  it('trims whitespace from titles', () => {
    const xml = `<rss><channel>
      <item>
        <title><![CDATA[  First Article  ]]></title>
        <link>https://example.com/1</link>
        <pubDate>Mon, 01 Jan 2026 10:00:00 GMT</pubDate>
      </item>
    </channel></rss>`;
    const result = parseRss(xml);
    expect(result[0].title).toBe('First Article');
  });

  it('populates link, id, and pubDate fields', () => {
    const xml = `<rss><channel>
      <item>
        <title>My Article</title>
        <link>https://example.com/article</link>
        <guid>guid-abc</guid>
        <pubDate>Mon, 05 Jan 2026 12:00:00 GMT</pubDate>
      </item>
    </channel></rss>`;
    const result = parseRss(xml);
    expect(result[0].link).toBe('https://example.com/article');
    expect(result[0].id).toBe('guid-abc');
    expect(result[0].pubDate).toBeTruthy();
    expect(!Number.isNaN(new Date(result[0].pubDate).getTime())).toBe(true);
  });

  it('falls back to title as id when both link and guid are missing', () => {
    const xml = `<rss><channel>
      <item>
        <title>Titleonly Article</title>
        <pubDate>Mon, 05 Jan 2026 12:00:00 GMT</pubDate>
      </item>
    </channel></rss>`;
    const result = parseRss(xml);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('Titleonly Article');
  });

  it('uses a valid ISO date string when pubDate is missing', () => {
    const xml = `<rss><channel>
      <item>
        <title>No Date Article</title>
        <link>https://example.com/nodate</link>
        <guid>guid-nodate</guid>
      </item>
    </channel></rss>`;
    const result = parseRss(xml);
    expect(result).toHaveLength(1);
    expect(!Number.isNaN(new Date(result[0].pubDate).getTime())).toBe(true);
  });

  it('returns [] for malformed XML with no item tags', () => {
    const xml = `<?xml version="1.0"?><rss><channel><title>Empty Feed</title></channel></rss>`;
    const result = parseRss(xml);
    expect(result).toEqual([]);
  });

  it('returns [] for Atom-style input with no item tags (known fall-through)', () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Atom Entry</title>
    <link href="https://example.com/atom-entry"/>
    <id>urn:uuid:atom-1</id>
    <updated>2026-01-05T12:00:00Z</updated>
  </entry>
</feed>`;
    const result = parseRss(xml);
    expect(result).toEqual([]);
  });

  it('does not throw on >100-char non-empty input that yields 0 items', () => {
    // This exercises the logger.debug path for non-standard feeds
    const xml = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Some Atom Feed With A Long Title</title><subtitle>Subtitle here</subtitle></feed>`;
    expect(xml.length).toBeGreaterThan(100);
    expect(() => parseRss(xml)).not.toThrow();
    const result = parseRss(xml);
    expect(result).toHaveLength(0);
  });

  it('skips items where title is only whitespace', () => {
    const xml = `<rss><channel>
      <item>
        <title>   </title>
        <link>https://example.com/blank</link>
        <guid>guid-blank</guid>
        <pubDate>Mon, 05 Jan 2026 12:00:00 GMT</pubDate>
      </item>
    </channel></rss>`;
    const result = parseRss(xml);
    expect(result).toHaveLength(0);
  });

  it('falls back to a valid ISO string when pubDate is unparseable', () => {
    const xml = `<rss><channel>
      <item>
        <title>Bad Date Article</title>
        <link>https://example.com/baddate</link>
        <guid>guid-baddate</guid>
        <pubDate>not-a-date</pubDate>
      </item>
    </channel></rss>`;
    const result = parseRss(xml);
    expect(result).toHaveLength(1);
    expect(!Number.isNaN(new Date(result[0].pubDate).getTime())).toBe(true);
  });
});
