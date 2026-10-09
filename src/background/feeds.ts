import { ACCENT_COLOR, MAX_CACHED_ITEMS, MAX_READ_ITEMS } from '../shared/constants';
import { alphaxivUrl, articleReaderUrl, isPdfUrl, readerPageUrl, shouldOpenInReader } from '../shared/pdf';
import { belongsInContinue } from '../shared/progress';
import { getLocal, setLocal } from '../shared/storage';
import type { FeedItem } from '../shared/types';
import { getYouTubeVideoId } from '../shared/youtube';
import { bypassPdfReader } from './pdfIntercept';
import { fetchFeed } from './rssParser';
import { registerOpenedTab } from './tracking';
import { focusExistingVideoTab } from './videoTracking';

/**
 * Fold a fetch into the cache. Refresh used to replace `cachedItems` outright,
 * so an unread article vanished the moment it scrolled out of its feed's
 * window. Merging by id also collapses the duplicate an aggregator and the
 * original site both carry, which previously rendered as two rows sharing a
 * React key.
 */
export function mergeFeedItems(
  existing: FeedItem[],
  incoming: FeedItem[],
  cap: number,
): FeedItem[] {
  // Incoming last so a refetched item's fresher metadata wins
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()]
    .sort((a, b) => +new Date(b.pubDate) - +new Date(a.pubDate))
    .slice(0, cap);
}

/**
 * `markItemRead` appends and evicts from the front, so the newest ids live at
 * the tail — the cap has to drop from the head. Prior history is kept rather
 * than overwritten: an item that has since left the cache is still read.
 */
export function applyMarkAllRead(
  readItems: string[],
  cachedItems: FeedItem[],
  cap: number,
): string[] {
  // cachedItems is newest-first; reverse so the newest ids land at the tail
  const cachedIds = cachedItems.map((item) => item.id).reverse();
  return [...new Set([...readItems, ...cachedIds])].slice(-cap);
}

export interface RefreshResult {
  ok: boolean;
  itemCount: number;
  newCount: number;
  failedCount: number;
}

export async function refreshFeeds(): Promise<RefreshResult> {
  const { feeds } = await getLocal('feeds');

  if (feeds.length === 0) {
    // Not setBadgeText('') — the badge no longer counts feed items, so blanking
    // it here would wipe the resumable-reading count every refresh tick.
    await updateBadge();
    return { ok: true, itemCount: 0, newCount: 0, failedCount: 0 };
  }

  const results = await Promise.allSettled(feeds.map((url) => fetchFeed(url)));
  const fetched = results.map((r) =>
    r.status === 'fulfilled' ? r.value : ({ ok: false, error: String(r.reason) } as const),
  );
  const failedCount = fetched.filter((r) => !r.ok).length;
  const incoming = fetched.flatMap((r) => (r.ok ? r.items : []));

  const { cachedItems } = await getLocal('cachedItems');

  // Every feed failed: keep the list the user already has rather than letting a
  // flaky network wipe it, and say so instead of reporting a successful refresh.
  if (failedCount === feeds.length) {
    await updateBadge();
    return { ok: false, itemCount: cachedItems.length, newCount: 0, failedCount };
  }

  const merged = mergeFeedItems(cachedItems, incoming, MAX_CACHED_ITEMS);
  // Counted against the old cache, not from the merged length, which stops
  // moving once the cap binds.
  const known = new Set(cachedItems.map((item) => item.id));
  const newCount = new Set(incoming.filter((item) => !known.has(item.id)).map((i) => i.id)).size;

  // cacheTimestamp is written even when nothing new arrived — it records the
  // last successful *check*, which is what "Updated 2m ago" claims and what the
  // staleness re-check reads. Skipping it would loop that check forever.
  await setLocal({ cachedItems: merged, cacheTimestamp: Date.now() });

  await updateBadge();
  return { ok: true, itemCount: merged.length, newCount, failedCount };
}

export async function updateBadge(): Promise<void> {
  // During a focus session the badge belongs to the countdown, not unread
  // counts. Read focusSession straight from storage — no focus.ts import,
  // so no module cycle.
  const { focusSession } = await getLocal('focusSession');
  if (focusSession) {
    const minutesLeft = Math.max(0, Math.ceil((focusSession.phaseEndsAt - Date.now()) / 60_000));
    await chrome.action.setBadgeText({ text: String(minutesLeft) });
    await chrome.action.setBadgeBackgroundColor({ color: '#333333' });
    return;
  }

  // Was the unread feed count, which pointed at a screen that does not exist —
  // no page renders cachedItems, and `feeds` defaults to empty, so the badge
  // was blank or meaningless. Resumable reading is something the dashboard
  // actually shows, so the number now leads somewhere. Capped low: a badge
  // reading 40 is noise, not an invitation.
  const { readingProgress, papers } = await getLocal('readingProgress', 'papers');
  const count =
    Object.values(readingProgress).filter((entry) => belongsInContinue(entry)).length +
    papers.filter((paper) => paper.status === 'reading').length;
  const badgeText = count > 9 ? '9+' : count > 0 ? String(count) : '';
  await chrome.action.setBadgeText({ text: badgeText });
  await chrome.action.setBadgeBackgroundColor({ color: ACCENT_COLOR });
}

/** Ids appended once each, in order; the oldest fall off past `cap`. */
export function appendRead(readItems: readonly string[], ids: readonly string[], cap: number): string[] {
  const next = [...readItems];
  const have = new Set(next);
  for (const id of ids) {
    if (have.has(id)) continue;
    have.add(id);
    next.push(id);
  }
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export async function markItemsRead(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const { readItems } = await getLocal('readItems');
  const next = appendRead(readItems, ids, MAX_READ_ITEMS);
  if (next.length !== readItems.length || next.some((id, i) => id !== readItems[i])) await setLocal({ readItems: next });
}

export async function markItemRead(itemId: string): Promise<void> {
  await markItemsRead([itemId]);
}

/** Marks everything in the current cache as read — no refetch needed */
export async function markAllRead(): Promise<{ ok: boolean; count: number }> {
  const { cachedItems, readItems } = await getLocal('cachedItems', 'readItems');
  const next = applyMarkAllRead(readItems, cachedItems, MAX_READ_ITEMS);
  await setLocal({ readItems: next });
  return { ok: true, count: cachedItems.length };
}

/**
 * Open a feed item. Readable pages go to the in-extension reader, which gives
 * them the same highlights, outline, Ask panel and resume that PDFs have had;
 * the reader reports progress through the same PROGRESS_UPDATE path, so
 * streaks and nudges are unaffected. Anything else opens as a normal tab with
 * the tracking content script, exactly as before.
 */
export async function openArticle(
  url: string,
  feedItemId: string | null,
  resume = false,
  readerView = true,
  original = false,
  alsoReadIds: readonly string[] = [],
): Promise<{ ok: boolean }> {
  // The row it was opened from may stand for the same story from other feeds;
  // reading one reads the story.
  await markItemsRead([...(feedItemId ? [feedItemId] : []), ...alsoReadIds]);

  // A video already open — the one Continue shows as playing — should be
  // brought forward, not duplicated into a second tab.
  const videoId = getYouTubeVideoId(url);
  if (videoId && (await focusExistingVideoTab(videoId))) {
    return { ok: true };
  }

  // PDFs go to the reader either way: Chrome's built-in viewer can't be
  // tracked at all, so the alternative is no progress and no resume.
  // `original` (Worth reading) opts out, interceptors included — they would
  // otherwise redirect the plain tab, extensionless PDFs too.
  if (original) {
    await bypassPdfReader(url);
  } else if (isPdfUrl(url)) {
    // arXiv PDFs go to alphaXiv, as the PDF interceptor does.
    await chrome.tabs.create({ url: alphaxivUrl(url) ?? readerPageUrl(url) });
    return { ok: true };
  }
  // Saved links pass readerView: false. shouldOpenInReader is true for nearly
  // every non-PDF page, and a link to Gmail or a dashboard is somewhere you go,
  // not something you read — it should open as itself.
  if (readerView && shouldOpenInReader(url)) {
    const readerTab = await chrome.tabs.create({ url: articleReaderUrl(url) });
    // Registered so progress lands on the key of the link that was clicked; the
    // reader can only report the URL it was handed, which a redirect changes.
    if (readerTab.id !== undefined) {
      await registerOpenedTab(readerTab.id, url, false);
    }
    return { ok: true };
  }

  const tab = await chrome.tabs.create({ url });
  if (tab.id !== undefined) {
    await registerOpenedTab(tab.id, url, resume);
  }
  return { ok: true };
}
