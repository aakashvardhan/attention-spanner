import { describe, expect, it } from 'vitest';
import { aggregateVisits, chromeTimeToMs, isoWeek, linkMeasure, linkTargets, notionPageId, notionTitle, toUuid } from './notion';
import type { NBlock } from './notionDb';

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

const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';
const P3 = '33333333-3333-3333-3333-333333333333';
const ROOT = '99999999-9999-9999-9999-999999999999';
const SPACE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const block = (b: Partial<NBlock> & { id: string }): NBlock => ({ type: 'text', parent_id: null, properties: null, format: null, alive: 1, ...b });

const vault: NBlock[] = [
  block({ id: ROOT, type: 'page', properties: '{"title":[["Root"]]}' }),
  block({ id: P1, type: 'page', parent_id: ROOT }),
  block({ id: P2, type: 'page', parent_id: ROOT }),
  block({ id: P3, type: 'page', parent_id: ROOT }),
  block({ id: 'b1', parent_id: P1, properties: `{"title":[["see "],["‣",[["p","${P2}","${SPACE}"]]]]}` }),
  block({ id: 'b2', type: 'alias', parent_id: P2, format: `{"alias_pointer":{"id":"${P1}","table":"block"}}` }),
  block({ id: 'b3', parent_id: P3, properties: `{"title":[["‣",[["p","${P1}","${SPACE}"]]]]}`, alive: 0 }),
];

describe('linkTargets', () => {
  it('reads link-to-page blocks and page mentions', () => {
    expect(linkTargets(vault[4])).toEqual([P2]);
    expect(linkTargets(vault[5])).toEqual([P1]);
    expect(linkTargets(block({ id: 'x', type: 'alias', format: 'broken' }))).toEqual([]);
  });
});

describe('linkMeasure', () => {
  it('counts pages with a link both in and out, ignoring deleted blocks', () => {
    expect(linkMeasure(vault, new Map(), { roots: [ROOT] })).toEqual({ pages: 4, connected: 2, share: 0.5 });
  });
  it('drops excluded subtrees from the scope', () => {
    expect(linkMeasure(vault, new Map(), { roots: [ROOT], exclude: [P2] })).toEqual({ pages: 3, connected: 0, share: 0 });
  });
  it('follows database rows up through their collection', () => {
    const rows = [...vault, block({ id: 'row', type: 'page', parent_id: 'coll' })];
    expect(linkMeasure(rows, new Map([['coll', P3]]), { roots: [ROOT] }).pages).toBe(5);
  });
});
