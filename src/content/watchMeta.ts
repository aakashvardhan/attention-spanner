/** How long ready waits for the watch page to show this video's own metadata. */
export const WATCH_META_WAIT_MS = 2000;

/**
 * The watch page's own title and channel, once it shows this video. Null while
 * the page still shows something else: after an SPA hop, `document.title` and
 * the first `ytd-channel-name` can belong to the previous video, a home-grid
 * card or a search, and a wrong title would misfile the video by topic. Null
 * too until the title has rendered; `document.title` is no stand-in for it.
 */
export function trustedWatchMeta(
  doc: Pick<Document, 'querySelector'>,
  videoId: string,
): { title: string; channel: string } | null {
  if (doc.querySelector('ytd-watch-flexy')?.getAttribute('video-id') !== videoId) return null;
  const title = doc.querySelector('ytd-watch-metadata h1')?.textContent?.trim() ?? '';
  if (!title) return null;
  const channel = doc.querySelector('ytd-watch-metadata ytd-channel-name a')?.textContent?.trim() ?? '';
  return { title, channel };
}

/** Keep waiting only while the tab is still on this video and time is left. */
export function shouldKeepPolling(urlVideoId: string | null, videoId: string, elapsedMs: number): boolean {
  return urlVideoId === videoId && elapsedMs < WATCH_META_WAIT_MS;
}
