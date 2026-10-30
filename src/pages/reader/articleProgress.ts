import { CONTINUE_MIN_SECONDS } from '../../shared/constants';

/** What the article scroller measures when it reports. */
export interface ArticleMetrics {
  hasText: boolean;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

/**
 * The progress report the article reader sends, or null for none yet.
 *
 * - Nothing until the article has rendered (text in the scroller and a
 *   measured height) and has a title: a URL or an empty name would stick as
 *   the Continue row's title.
 * - A scrollable article reports how far it is scrolled.
 * - An article that fits the viewport is not "finished" on sight: it reports
 *   0% until it has been open CONTINUE_MIN_SECONDS, then 100%. Otherwise a
 *   fresh "read this" lands as completed and never shows in Continue.
 */
export function articleProgressReport(
  title: string,
  m: ArticleMetrics,
  secondsRendered: number,
): { percent: number; title: string } | null {
  if (!title || !m.hasText || m.clientHeight <= 0) return null;
  const scrollable = m.scrollHeight - m.clientHeight;
  if (scrollable <= 0) return { percent: secondsRendered >= CONTINUE_MIN_SECONDS ? 100 : 0, title };
  return { percent: Math.max(0, Math.min(100, Math.round((m.scrollTop / scrollable) * 100))), title };
}
