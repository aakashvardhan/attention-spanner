import { describe, expect, it } from 'vitest';
import { aggregateVisits, chromeTimeToMs, isoWeek, notionPageId, notionTitle, toUuid } from './notion';

const ID = '305a8b0b-408d-800b-bfca-c9072e86e85c';
const HEX = '305a8b0b408d800bbfcac9072e86e85c';

describe('notionPageId', () => {
  it('reads the id at the end of a page URL', () => {
    expect(notionPageId(`https://www.notion.so/space/Deep-Learning-Class-${HEX}`)).toBe(ID);
  });
  it('prefers the side peek (?p=) over the page behind it', () => {
    expect(notionPageId(`https://www.notion.so/space/Board-1111111111111111aaaaaaaaaaaaaaaa?p=${HEX}&pm=s`)).toBe(ID);
  });
  it('reads app.notion.com, notion.site and dashed ids', () => {
    expect(notionPageId('https://app.notion.com/p/job-tracker-3d7a8b0b408d801ca8bad7dc07e6e3e7?source=copy_link')).toBe(
      '3d7a8b0b-408d-801c-a8ba-d7dc07e6e3e7',
    );
    expect(notionPageId(`https://someone.notion.site/Public-Page-${HEX}`)).toBe(ID);
    expect(notionPageId(`https://www.notion.so/${ID}`)).toBe(ID);
  });
  it('ignores non-page Notion URLs and other sites', () => {
    expect(notionPageId('https://www.notion.so/login')).toBeNull();
    expect(notionPageId(`https://example.com/${HEX}`)).toBeNull();
    expect(notionPageId('not a url')).toBeNull();
  });
});

describe('time', () => {
  it('converts Chrome microseconds since 1601 to Unix milliseconds', () => {
    expect(chromeTimeToMs(11644473600000000)).toBe(0);
    expect(chromeTimeToMs(11644473600000000 + 86_400_000_000)).toBe(86_400_000);
  });
  it('names ISO weeks, including week 53 and the year boundary', () => {
    expect(isoWeek(Date.UTC(2026, 0, 1))).toBe('2026-W01');
    expect(isoWeek(Date.UTC(2025, 11, 29))).toBe('2026-W01');
    expect(isoWeek(Date.UTC(2027, 0, 1))).toBe('2026-W53');
  });
});

describe('aggregateVisits', () => {
  it('counts visits per page and per week and keeps the latest', () => {
    const a = Date.UTC(2026, 9, 12), b = Date.UTC(2026, 9, 14);
    expect(aggregateVisits([{ id: ID, ms: a }, { id: ID, ms: b }, { id: null, ms: b }])).toEqual({
      [ID]: { visits: 2, weeks: { '2026-W42': 2 }, lastVisit: new Date(b).toISOString() },
    });
  });
});

describe('notionTitle and toUuid', () => {
  it('joins the text runs of a title', () => {
    expect(notionTitle('{"title":[["Deep "],["Learning",[["b"]]]]}')).toBe('Deep Learning');
    expect(notionTitle(null)).toBe('');
    expect(notionTitle('not json')).toBe('');
  });
  it('dashes a 32-character id', () => {
    expect(toUuid(HEX.toUpperCase())).toBe(ID);
  });
});
