import { describe, expect, it } from 'vitest';
import { backlinks, buildEntry, contentHash, duplicateTitles, inlineTags, targetsOf } from './entry';

const SIGMOID = '---\ntags: [concept, "#ml"]\naliases: Logistic function\nsources: ["[[Lecture 3]]"]\n---\n# Sigmoid\n\nSee [[Gradient descent]] and #maths, not #2026 or `#code`.\n\n- [ ] derive it\n';

describe('buildEntry', () => {
  const e = buildEntry('Concepts/Sigmoid.md', SIGMOID);
  it('reads title, aliases and tags from frontmatter and body', () => {
    expect(e.title).toBe('Sigmoid');
    expect(e.aliases).toEqual(['Logistic function']);
    expect(e.tags).toEqual(['concept', 'ml', 'maths']);
  });
  it('collects body and property links, headings and tasks, with body offsets', () => {
    expect(e.links.map((l) => [l.target, l.property])).toEqual([
      ['Gradient descent', null],
      ['Lecture 3', 'sources'],
    ]);
    expect(e.body.slice(e.links[0].from, e.links[0].to)).toBe('[[Gradient descent]]');
    expect(e.headings.map((h) => h.text)).toEqual(['Sigmoid']);
    expect(e.tasks.map((t) => t.text)).toEqual(['derive it']);
    expect(SIGMOID.slice(e.bodyStart)).toBe(e.body);
  });
  it('indexes a 1 MB note quickly', () => {
    const big = Array.from({ length: 20_000 }, (_, i) => (i % 50 === 0 ? `## Part ${i}` : `Line ${i} links [[Note ${i % 97}]] and says something.`)).join('\n');
    const t0 = performance.now();
    const b = buildEntry('Big.md', big);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(b.links).toHaveLength(19_600);
  });
});

describe('inlineTags', () => {
  it('skips headings, numbers, code and links', () => {
    expect(inlineTags('# Title\n#tag1 [[Note#Heading]] #2026 ` #x` (#nested/tag)', [[37, 42]])).toEqual(['tag1', 'nested/tag']);
  });
});

describe('targets, backlinks and duplicates', () => {
  const a = buildEntry('Concepts/Sigmoid.md', SIGMOID);
  const b = buildEntry('School/Lecture 3.md', '# Lecture 3\n\n[[Sigmoid]], [[Logistic function]] and [[Missing]].\n');
  const c = buildEntry('Inbox/Logistic function.md', '# A note whose title is another note\'s alias\n');
  it('lets a title win over an alias', () => {
    expect(targetsOf([a, b, c], []).notes.get('logistic function')).toBe('Inbox/Logistic function.md');
    expect(targetsOf([a, b], []).notes.get('logistic function')).toBe('Concepts/Sigmoid.md');
  });
  it('derives backlinks, property links included, unresolved and alias links left out', () => {
    const bl = backlinks([a, b], targetsOf([a, b], []));
    expect(bl.get('Concepts/Sigmoid.md')?.map((x) => x.link.target)).toEqual(['Sigmoid']);
    expect(bl.get('School/Lecture 3.md')?.map((x) => x.link.property)).toEqual(['sources']);
  });
  it('finds two files with one title', () => {
    expect(duplicateTitles([a, buildEntry('Inbox/sigmoid.md', '')])).toEqual([['Concepts/Sigmoid.md', 'Inbox/sigmoid.md']]);
  });
  it('hashes content with SHA-256', async () => {
    expect(await contentHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
