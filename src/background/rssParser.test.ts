import { describe, expect, it } from 'vitest';
import { parseFeedXml } from './rssParser';

const RSS = (items: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Test Feed</title>
  ${items}
</channel></rss>`;

const ATOM = (entries: string) => `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  ${entries}
</feed>`;

describe('parseFeedXml categories', () => {
  it('collects repeated RSS <category> tags', () => {
    const [item] = parseFeedXml(
      RSS(`<item>
        <title>Post</title>
        <link>https://example.com/a</link>
        <category>Tech</category>
        <category>AI</category>
      </item>`),
      'https://example.com/feed',
    );
    expect(item.categories).toEqual(['Tech', 'AI']);
  });

  it('handles a single RSS <category> and dedupes', () => {
    const [item] = parseFeedXml(
      RSS(`<item>
        <title>Post</title>
        <link>https://example.com/b</link>
        <category>News</category>
      </item>`),
      'https://example.com/feed',
    );
    expect(item.categories).toEqual(['News']);
  });

  it('reads Atom <category term="...">', () => {
    const [item] = parseFeedXml(
      ATOM(`<entry>
        <title>Entry</title>
        <link rel="alternate" href="https://example.com/c" />
        <category term="Science" />
        <category term="Physics" />
      </entry>`),
      'https://example.com/atom',
    );
    expect(item.categories).toEqual(['Science', 'Physics']);
  });

  it('yields an empty array when no categories are present', () => {
    const [item] = parseFeedXml(
      RSS(`<item>
        <title>Post</title>
        <link>https://example.com/d</link>
      </item>`),
      'https://example.com/feed',
    );
    expect(item.categories).toEqual([]);
  });
});
