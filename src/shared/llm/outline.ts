import type { AiRequest } from './generate';
import type { AiSource } from './route';

/**
 * The reader's AI outline: a handful of bullets that walk through a paper, each
 * pointing at the page it came from so a click lands there.
 */

export const OUTLINE_SYSTEM =
  'You outline a research paper for a reader who has ADHD. Using only the numbered pages ' +
  'given, write 6 to 10 Markdown bullet points that walk through the paper in order: the ' +
  'problem, the idea, the method, the key results, the limits. One short sentence each. End ' +
  'every bullet with the page it comes from as [n]. No preamble, no headings, no emoji.';

export function outlineRequest(opts: { key: string; passages: string[]; source: AiSource }): AiRequest {
  return {
    task: 'summarize',
    source: opts.source,
    system: OUTLINE_SYSTEM,
    passages: opts.passages,
    numbered: true,
    prompt: 'Outline this paper.',
    cacheKey: opts.key,
  };
}

export interface OutlineBullet {
  text: string;
  /** 1-based page the bullet cites; null when it cites none or one out of range */
  page: number | null;
}

/** Bullets out of the model's Markdown, with their first [n] page citation. */
export function parseOutline(markdown: string, pageCount: number): OutlineBullet[] {
  const bullets: OutlineBullet[] = [];
  for (const raw of markdown.split('\n')) {
    const m = raw.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (!m) continue;
    const cite = m[1].match(/\[(\d{1,4})\s*[,\]]/);
    const n = cite ? Number(cite[1]) : 0;
    const text = m[1]
      .replace(/\s*\[\d{1,4}(?:\s*,\s*\d{1,4})*\]/g, '')
      .replace(/\*\*|__|`/g, '')
      .trim();
    if (text) bullets.push({ text, page: n >= 1 && n <= pageCount ? n : null });
  }
  return bullets;
}
