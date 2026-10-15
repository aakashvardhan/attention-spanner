import { describe, expect, it } from 'vitest';
import { buildEntry } from './entry';
import { linkMention, unlinkedMentions } from './mentions';

const TARGET = { path: 'Concepts/Sigmoid.md', title: 'Sigmoid', aliases: ['Logistic function', 'σ'] };
const TEXT = '---\nnote: sigmoid in frontmatter\n---\nThe sigmoid works. Sigmoidal is another word. [[Sigmoid]] is linked, `sigmoid` is code, and the logistic Function too.\n';

describe('unlinkedMentions', () => {
  const e = buildEntry('Lecture.md', TEXT);
  const ms = unlinkedMentions(TARGET, [e, buildEntry(TARGET.path, 'Sigmoid itself mentions sigmoid.')]);
  it('finds the title and aliases as whole words, ignoring case', () => {
    expect(ms.map((m) => m.text)).toEqual(['sigmoid', 'logistic Function']);
  });
  it('gives offsets into the whole file, frontmatter included', () => {
    expect(ms.every((m) => TEXT.slice(m.from, m.to) === m.text)).toBe(true);
  });
  it('turns a mention into a link, keeping its wording', () => {
    const [first, second] = ms;
    expect(linkMention(TEXT, first, 'Sigmoid')).toContain('The [[Sigmoid|sigmoid]] works.');
    expect(linkMention(TEXT, second, 'Sigmoid')).toContain('the [[Sigmoid|logistic Function]] too.');
    expect(linkMention('Sigmoid here', { path: 'x', from: 0, to: 7, text: 'Sigmoid' }, 'Sigmoid')).toBe('[[Sigmoid]] here');
  });
});
