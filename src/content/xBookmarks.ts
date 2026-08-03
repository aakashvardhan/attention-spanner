import { extensionAlive, sendMessage } from '../shared/messages';
import type { XBookmark } from '../shared/types';

declare global {
  interface Window {
    __readerXBookmarksAlive?: () => boolean;
    __readerXBookmarksStop?: () => void;
  }
}

if (window.__readerXBookmarksAlive?.() !== true) {
  window.__readerXBookmarksStop?.();
  init();
}

function init() {
  let timer = 0;
  const alive = () => extensionAlive();

  const extract = (): XBookmark[] => {
    const capturedAt = Date.now();
    const found = new Map<string, XBookmark>();
    for (const article of document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]')) {
      const statusLink = [...article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')]
        .find((link) => /^\/[A-Za-z0-9_]+\/status\/\d+/.test(new URL(link.href).pathname));
      if (!statusLink) continue;
      const match = new URL(statusLink.href).pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);
      if (!match) continue;
      const [, handle, id] = match;
      const time = article.querySelector<HTMLTimeElement>('time');
      const userName = article.querySelector<HTMLElement>('[data-testid="User-Name"]');
      const nameParts = userName?.innerText.split('\n').map((part) => part.trim()).filter(Boolean) ?? [];
      const authorName = nameParts.find((part) => !part.startsWith('@')) ?? handle;
      const text = article.querySelector<HTMLElement>('[data-testid="tweetText"]')?.innerText.trim() ?? '';
      found.set(id, {
        id,
        url: `https://x.com/${handle}/status/${id}`,
        text,
        authorName,
        authorHandle: `@${handle}`,
        postedAt: time?.dateTime ? Date.parse(time.dateTime) || null : null,
        capturedAt,
      });
    }
    return [...found.values()];
  };

  const sync = async () => {
    if (!alive()) return teardown();
    try {
      await sendMessage({ type: 'X_BOOKMARKS_SYNC', items: extract() });
    } catch {
      teardown();
    }
  };
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void sync(), 700);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });

  const teardown = () => {
    window.clearTimeout(timer);
    observer.disconnect();
    if (window.__readerXBookmarksAlive === alive) {
      delete window.__readerXBookmarksAlive;
      delete window.__readerXBookmarksStop;
    }
  };
  window.__readerXBookmarksAlive = alive;
  window.__readerXBookmarksStop = teardown;
  schedule();
}
