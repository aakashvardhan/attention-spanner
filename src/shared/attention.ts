import type { AnyProgress, ResumeTarget, Paper } from './types';
import { belongsInContinue, progressKeyFor } from './progress';
import { cleanVideoTitle } from './youtube';

export function resumeContextFromProgress(progress: AnyProgress): ResumeTarget {
  if (progress.kind === 'video') {
    return {
      kind: 'video',
      url: progress.url,
      title: progress.title || progress.url,
      positionSeconds: progress.positionSeconds,
    };
  }
  return {
    kind: 'article',
    url: progress.url,
    title: progress.title || progress.url,
    scrollY: progress.scrollY,
  };
}

/** One resumable thing: an unfinished read/watch, or a paper mid-flight. */
export interface ResumableItem {
  key: string;
  title: string;
  updatedAt: number;
  /** Papers open through the PDF reader; progress entries through OPEN_ARTICLE. */
  paper: Paper | null;
  progress: AnyProgress | null;
}

/**
 * Everything worth picking back up, newest first.
 *
 * This answers "what is still open", which is what makes a new tab worth opening at all — the dashboard had no such list,
 * so a half-read article was invisible until you remembered it yourself.
 */
export function resumableItems(
  progress: Record<string, AnyProgress>,
  papers: readonly Paper[],
  now = Date.now(),
): ResumableItem[] {
  // One row per page actually read: two feed links (two feeds, or a redirect)
  // key the same article twice, and both entries end up naming that page.
  const newest = new Map<string, AnyProgress>();
  for (const entry of Object.values(progress)) {
    if (!belongsInContinue(entry, now)) continue;
    const page = progressKeyFor(entry.url);
    const seen = newest.get(page);
    if (!seen || entry.updatedAt > seen.updatedAt) newest.set(page, entry);
  }
  const fromProgress = [...newest.values()]
    .map((entry) => ({
      key: `progress:${entry.url}`,
      // Entries saved before titles were cleaned still carry YouTube's "(37)" count.
      title: (entry.kind === 'video' ? cleanVideoTitle(entry.title) : entry.title) || entry.url,
      updatedAt: entry.updatedAt,
      paper: null,
      progress: entry,
    }));
  const fromPapers = papers
    .filter((paper) => paper.status === 'reading')
    .map((paper) => ({
      key: `paper:${paper.id}`,
      title: paper.title,
      updatedAt: paper.lastReadAt ?? paper.addedAt,
      paper,
      progress: null,
    }));
  // No cap: the dashboard shows the newest few and discloses the rest. A cap
  // here silently dropped the seventh unfinished article with no way back.
  return [...fromProgress, ...fromPapers].sort((a, b) => b.updatedAt - a.updatedAt);
}
