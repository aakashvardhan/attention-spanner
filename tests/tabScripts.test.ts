import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// page-text.js cuts a page into sections and tab-mark.mjs finds where each
// starts. Both run in the tab as self-contained source (executeScript sends
// no imports), so they cannot share the selectors: this keeps them equal.
const read = (f: string) => readFileSync(join(__dirname, '../rust/ext/js', f), 'utf8');
const pageText = read('page-text.js');
const tabMark = read('tab-mark.mjs');
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const ROOT = /document\.querySelector\('([^']+)'\)/;

describe('the scripts run in a tab', () => {
  it('read and mark the same main content', () => {
    expect(pageText.match(ROOT)?.[1]).toBe('article, main, [role=main]');
    expect(tabMark.match(ROOT)?.[1]).toBe(pageText.match(ROOT)?.[1]);
  });

  it('mark the blocks page-text.js reads, and the loose text it gathers from divs', () => {
    const head = pageText.match(/const HEAD = '([^']+)'/)?.[1] ?? '';
    const all = pageText.match(/const ALL = `\$\{HEAD\}, ([^`]+)`/)?.[1] ?? '';
    const blocks = [...list(head), ...list(all)];
    const marked = list(tabMark.match(/querySelectorAll\('([^']+)'\)/)?.[1] ?? '');
    expect(blocks.length).toBeGreaterThan(10);
    expect(marked).toEqual([...blocks, 'div']);
  });
});
