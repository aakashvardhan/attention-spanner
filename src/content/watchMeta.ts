/**
 * The watch page's own title and channel, once it shows this video. Null while
 * the page still shows something else: after an SPA hop, `document.title` and
 * the first `ytd-channel-name` can belong to the previous video or a home-grid
 * card, and a wrong title would misfile the video by topic.
 */
export function trustedWatchMeta(
  doc: Pick<Document, 'querySelector' | 'title'>,
  videoId: string,
): { title: string; channel: string } | null {
  if (doc.querySelector('ytd-watch-flexy')?.getAttribute('video-id') !== videoId) return null;
  const title =
    doc.querySelector('ytd-watch-metadata h1')?.textContent?.trim() ||
    doc.title.replace(/ - YouTube$/, '').trim();
  const channel = doc.querySelector('ytd-watch-metadata ytd-channel-name a')?.textContent?.trim() ?? '';
  return { title, channel };
}
