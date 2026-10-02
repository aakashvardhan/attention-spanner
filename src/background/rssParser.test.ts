import { describe, expect, it } from 'vitest';
import { generateItemId, parseFeedXml } from './rssParser';

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

describe('generateItemId', () => {
  it('separates articles that share a host', () => {
    // The old scheme truncated to 24 bytes of encodeURIComponent output, which
    // `https%3A%2F%2F` plus ten characters of hostname consumed entirely — so
    // every article on a site collided, and reading one marked them all read.
    expect(generateItemId('https://news.ycombinator.com/item?id=111', 'One')).not.toBe(
      generateItemId('https://news.ycombinator.com/item?id=222', 'Two'),
    );
    expect(generateItemId('https://arstechnica.com/gadgets/2026/07/a/', 'Gadgets')).not.toBe(
      generateItemId('https://arstechnica.com/science/2026/07/b/', 'Science'),
    );
  });

  it('separates two titles at the same link', () => {
    expect(generateItemId('https://example.com/a', 'First')).not.toBe(
      generateItemId('https://example.com/a', 'Second'),
    );
  });

  it('is stable for the same input, so read state survives a refetch', () => {
    expect(generateItemId('https://example.com/a', 'Post')).toBe(
      generateItemId('https://example.com/a', 'Post'),
    );
  });

  it('handles non-Latin titles', () => {
    // btoa throws on characters outside Latin-1 — the id must never be a crash
    expect(() => generateItemId('https://example.com/a', '日本語のタイトル')).not.toThrow();
    expect(generateItemId('https://example.com/a', '日本語')).not.toBe(
      generateItemId('https://example.com/a', '한국어'),
    );
  });
});

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
