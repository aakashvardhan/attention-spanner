import { describe, expect, it } from 'vitest';
import { buildPdfContext, pdfAnswerCacheKey } from './pdfQa';

describe('buildPdfContext', () => {
  it('returns the whole paper when it fits the budget', () => {
    const fullText = 'abc'.repeat(10); // 30 chars
    const ctx = buildPdfContext({ fullText, currentPage: 1, pageCount: 5, budget: 100 });
    expect(ctx.partial).toBe(false);
    expect(ctx.text).toBe(fullText);
  });

  it('returns the whole paper at exactly the budget (boundary)', () => {
    const fullText = 'x'.repeat(100);
    const ctx = buildPdfContext({ fullText, currentPage: 1, pageCount: 1, budget: 100 });
    expect(ctx.partial).toBe(false);
    expect(ctx.text.length).toBe(100);
  });

  it('sends a budget-sized window centered on the current page when too big', () => {
    // 1000 chars, page 5 of 10 -> center ~= 400, budget 100 -> window [350, 450)
    const fullText = Array.from({ length: 1000 }, (_, i) => String.fromCharCode(33 + (i % 90))).join('');
    const ctx = buildPdfContext({ fullText, currentPage: 5, pageCount: 10, budget: 100 });
    expect(ctx.partial).toBe(true);
    expect(ctx.text.length).toBe(100);
    expect(ctx.text).toBe(fullText.slice(350, 450));
  });

  it('clamps the window to the start of the paper on page 1', () => {
    const fullText = 'y'.repeat(1000);
    const ctx = buildPdfContext({ fullText, currentPage: 1, pageCount: 10, budget: 100 });
    expect(ctx.partial).toBe(true);
    expect(ctx.text.length).toBe(100);
  });

  it('windows near the end of the paper on the last page', () => {
    // 1100 chars, page 10 of 10 -> center = round(0.9*1100) = 990, budget 100 -> [940, 1040)
    const fullText = 'z0123456789'.repeat(100); // 1100 chars
    const ctx = buildPdfContext({ fullText, currentPage: 10, pageCount: 10, budget: 100 });
    expect(ctx.partial).toBe(true);
    expect(ctx.text.length).toBe(100);
    expect(ctx.text).toBe(fullText.slice(940, 1040));
  });
});

describe('pdfAnswerCacheKey', () => {
  const paper = 'the full text of the paper';

  it('is stable across case and trailing punctuation in the question', () => {
    const a = pdfAnswerCacheKey('Summarize this paper', 'Title', paper, []);
    const b = pdfAnswerCacheKey('summarize this paper.', 'Title', paper, []);
    expect(a).toBe(b);
  });

  it('changes when the paper context changes (different doc or page window)', () => {
    const a = pdfAnswerCacheKey('summarize', 'Title', paper, []);
    const b = pdfAnswerCacheKey('summarize', 'Title', paper + ' extra', []);
    expect(a).not.toBe(b);
  });

  it('changes when the conversation history changes', () => {
    const a = pdfAnswerCacheKey('and the results?', 'Title', paper, []);
    const b = pdfAnswerCacheKey('and the results?', 'Title', paper, [
      { role: 'user', text: 'what problem does it solve?' },
      { role: 'assistant', text: 'it solves X.' },
    ]);
    expect(a).not.toBe(b);
  });
});
