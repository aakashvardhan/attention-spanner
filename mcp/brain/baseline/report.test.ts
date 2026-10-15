import { describe, expect, it } from 'vitest';
import { baselineMarkdown } from './report';

describe('baselineMarkdown', () => {
  it('reports what ran and marks what did not', () => {
    const md = baselineMarkdown({
      links: { pages: 200, connected: 30, share: 0.15 },
      recall: { tool: 'notion', date: '2026-10-15', n: 25, successRate: 0.64, medianMs: 41_500 },
      exportPath: '~/Documents/notion-export/2026-10-15',
    });
    expect(md).toContain('| Connections (Notion) | 30 of 200 pages link both ways (15.0%) |');
    expect(md).toContain('| Fast recall (Notion) | 64% found, median 41.5 s (25 questions, 2026-10-15) |');
    expect(md).toContain('| Usage | not run yet |');
    expect(md).toContain('| Card sort | not run yet |');
    expect(md).toContain('~/Documents/notion-export/2026-10-15');
  });
  it('marks a measure the user declined as declined, not as pending', () => {
    const md = baselineMarkdown({ declined: ['recall'] });
    expect(md).toContain('| Fast recall (Notion) | declined by the user |');
    expect(md).toContain('| Usage | not run yet |');
  });
});
