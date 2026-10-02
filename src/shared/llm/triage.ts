import type { AnyProgress, FeedItem, Paper } from '../types';
import { cosine } from './vectors';

/**
 * "Worth reading": rank unread feed items by how close they sit to what you
 * actually finish — papers you are reading or have read, and articles you got
 * to the end of. Ranking is embeddings only; no text generation, so it costs a
 * few hundred milliseconds and nothing leaves the machine.
 */

export interface ProfileEntry {
  /** Stable for the same text, so its vector can be cached */
  id: string;
  /** Shown as "Because you read …" */
  label: string;
  text: string;
}

const PROFILE_DAYS = 30;
const PROFILE_MAX = 30;

export function interestProfile(
  papers: readonly Paper[],
  progress: Record<string, AnyProgress>,
  now: number,
): ProfileEntry[] {
  const fromPapers = papers
    .filter((p) => p.status === 'reading' || p.status === 'read')
    .sort((a, b) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt))
    .map((p) => ({
      id: `paper:${p.id}`,
      label: p.title,
      text: `${p.title}. ${p.abstract.slice(0, 500)}`,
    }));
  const since = now - PROFILE_DAYS * 24 * 60 * 60_000;
  const fromArticles = Object.values(progress)
    .filter((e) => e.kind !== 'video' && e.completedAt !== null && e.completedAt >= since && e.title)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
    .map((e) => ({ id: `read:${e.url}`, label: e.title, text: e.title }));
  return [...fromPapers, ...fromArticles].slice(0, PROFILE_MAX);
}

export function unreadItems(items: readonly FeedItem[], readIds: readonly string[], cap: number): FeedItem[] {
  const read = new Set(readIds);
  return items.filter((item) => !read.has(item.id)).slice(0, cap);
}

export function itemText(item: FeedItem): string {
  return item.snippet ? `${item.title}. ${item.snippet}` : item.title;
}

export interface Pick {
  item: FeedItem;
  /** The profile entry this item is close to; null when nothing is close */
  because: string | null;
}

/**
 * Below this, "Because you read X" would be a false claim — the item is merely
 * the least unrelated. It still ranks, it just names no reason. A calibration
 * knob for nomic-embed-text; another embedding model wants its own number.
 */
export const TRIAGE_REASON_MIN = 0.5;

/**
 * Best `k` items by their closest profile entry. Items or entries without a
 * vector are skipped rather than scored as zero, so a half-filled cache can
 * only leave something out, never rank it wrongly. A reason is only given for
 * a match of at least `minReason`.
 */
export function rankItems(
  items: readonly FeedItem[],
  itemVector: (item: FeedItem) => ArrayLike<number> | undefined,
  profile: readonly ProfileEntry[],
  profileVector: (entry: ProfileEntry) => ArrayLike<number> | undefined,
  k: number,
  minReason = TRIAGE_REASON_MIN,
): Pick[] {
  const entries = profile
    .map((entry) => ({ entry, vector: profileVector(entry) }))
    .filter((e): e is { entry: ProfileEntry; vector: ArrayLike<number> } => e.vector !== undefined);
  if (entries.length === 0) return newest(items, k);

  return items
    .map((item) => {
      const vector = itemVector(item);
      if (!vector) return null;
      let best = -Infinity;
      let because = '';
      for (const { entry, vector: other } of entries) {
        const score = cosine(vector, other);
        if (score > best) {
          best = score;
          because = entry.label;
        }
      }
      return { item, because, score: best };
    })
    .filter((hit): hit is { item: FeedItem; because: string; score: number } => hit !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ item, because, score }) => ({ item, because: score >= minReason ? because : null }));
}

export function newest(items: readonly FeedItem[], k: number): Pick[] {
  return items.slice(0, k).map((item) => ({ item, because: null }));
}
