import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation, Paper } from '../types';
import { recallEntries } from './recall';

const annotation = (patch: Partial<Annotation>): Annotation =>
  ({
    id: 'a1',
    docKey: 'doc',
    docUrl: 'https://example.com/post',
    paperId: null,
    kind: 'highlight',
    anchor: { kind: 'text', blockIndex: 0, quote: '', prefix: '', suffix: '' },
    text: 'Highlighted words',
    color: 'yellow',
    note: '',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }) as Annotation;

beforeEach(() => {
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://id/${path}` } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('recallEntries', () => {
  const papers = [
    { id: 'p1', title: 'A Paper', abstract: 'What it found.', url: 'https://arxiv.org/abs/1', pdf: undefined },
    { id: 'p2', title: 'No abstract', abstract: '  ', url: 'https://arxiv.org/abs/2', pdf: undefined },
  ] as unknown as Paper[];

  it('indexes highlights with their note, and papers with an abstract', () => {
    const entries = recallEntries([annotation({ note: 'my thought' })], papers);
    expect(entries.map((e) => e.key)).toEqual(['annot:a1', 'abstract:p1']);
    expect(entries[0].text).toBe('Highlighted words\nmy thought');
  });

  it('skips an empty sticky note, which has nothing to search', () => {
    expect(recallEntries([annotation({ kind: 'sticky', text: '', note: '' })], [])).toEqual([]);
  });

  it('names a highlight by its paper when it has one, else by its page', () => {
    const [onPaper] = recallEntries([annotation({ paperId: 'p1' })], papers);
    expect(onPaper.title).toBe('A Paper');
    const [onPage] = recallEntries([annotation({})], []);
    expect(onPage.title).toBe('example.com/post');
  });

  it('opens a PDF highlight in the PDF reader and a text one in the article reader', () => {
    const pdf = annotation({ anchor: { kind: 'pdf', page: 2, rects: [], x: 0, y: 0 } });
    const [pdfEntry, textEntry] = recallEntries([pdf, annotation({ id: 'a2' })], []);
    expect(pdfEntry.url).toContain('src=');
    expect(textEntry.url).toContain('article=');
  });
});
