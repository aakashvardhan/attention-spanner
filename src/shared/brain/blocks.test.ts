import { describe, expect, it } from 'vitest';
import { structure } from './blocks';

const BODY = [
  '# Title',
  '',
  'Intro with `code [[x]]`.',
  '',
  '## Part',
  '',
  '- one',
  '- [ ] todo item',
  '  - [x] done child',
  '- three',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '> [!note]- Folded',
  '> inside',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  'Setext',
  '===',
  '',
].join('\n');

describe('structure', () => {
  const s = structure(BODY);
  it('splits a note into blocks, one per list item, one per quote', () => {
    expect(s.blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'heading', 'item', 'item', 'item', 'item', 'code', 'quote', 'table', 'heading']);
    expect(s.blocks.filter((b) => b.kind === 'item').map((b) => b.text)).toEqual(['one', 'todo item', 'done child', 'three']);
  });
  it('names the section each block sits in', () => {
    expect(s.blocks[1].section).toBe('Title');
    expect(s.blocks[3].section).toBe('Part');
  });
  it('reads headings with levels, ATX and setext', () => {
    expect(s.headings.map((h) => [h.level, h.text])).toEqual([
      [1, 'Title'],
      [2, 'Part'],
      [1, 'Setext'],
    ]);
  });
  it('reads tasks and their state, nested ones too', () => {
    expect(s.tasks.map((t) => [t.text, t.done])).toEqual([
      ['todo item', false],
      ['done child', true],
    ]);
  });
  it('records inline and fenced code so links inside them can be skipped', () => {
    expect(s.code.map(([a, b]) => BODY.slice(a, b))).toEqual(['`code [[x]]`', '```js\nconst a = 1;\n```']);
  });
  it('ends a table at a following quote, as GFM does', () => {
    expect(structure('| abc | def |\n| --- | --- |\n| bar | baz |\n> bar\n').blocks.map((b) => b.kind)).toEqual(['table', 'quote']);
  });
  it('strips the closing hashes of an ATX heading', () => {
    expect(structure('## Uses ##\n').headings[0].text).toBe('Uses');
  });
});
