/**
 * Timedtext tee — MAIN world, document_start, YouTube pages only. Registered
 * by src/background/recordings.ts via chrome.scripting.registerContentScripts.
 *
 * YouTube serves caption tracks only to the player's own request: the URL
 * carries a single-use proof-of-origin token minted by BotGuard, so refetching
 * it — from any context — returns 200 with an empty body (verified). The one
 * copy of the data that exists in reach is the response body of the player's
 * own request, and the player binds its fetch/XMLHttpRequest references at
 * boot — which is why this must run at document_start, before the player does.
 *
 * It only stashes; it never sends. The capture step
 * (shared/youtubeTabCaptions.ts, injected on demand into the same MAIN world)
 * reads `__readerTimedtext` back. No chrome.* APIs exist in MAIN world anyway.
 *
 * Bundled standalone (IIFE) by esbuild, same as readingTracker/videoTracker.
 */

declare global {
  interface Window {
    __readerTimedtext?: { url: string; body: string; at: number } | null;
    /**
     * Puts window.fetch and XMLHttpRequest back the way they were. The patches
     * below outlive the extension otherwise — nothing re-injects this script on
     * a reload, so an orphaned tee would keep wrapping every request on the page
     * for as long as the tab is open. Every other content script here evicts
     * its orphan; this is that hook.
     */
    __readerTimedtextStop?: () => void;
  }
}

(() => {
  // Double-injection guard (SPA navigations never re-inject, but be safe)
  if (window.__readerTimedtext !== undefined) return;
  window.__readerTimedtext = null;

  const stash = (url: string, body: string) => {
    if (body) window.__readerTimedtext = { url, body, at: Date.now() };
  };

  const origFetch = window.fetch;
  window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
    const result = origFetch.apply(this, args);
    try {
      const first = args[0] as { url?: string } | string;
      const url = typeof first === 'string' ? first : (first?.url ?? '');
      if (url.indexOf('/api/timedtext') !== -1) {
        result
          .then((res) => {
            res
              .clone()
              .text()
              .then((t) => stash(url, t))
              .catch(() => undefined);
            return res;
          })
          .catch(() => undefined);
      }
    } catch {
      // The tee must never break the page's own request
    }
    return result;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  // `open` is overloaded, which Parameters<> can't represent — wrap loosely
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest & { __readerTtUrl?: string },
    ...args: unknown[]
  ) {
    this.__readerTtUrl = String(args[1]);
    return (origOpen as unknown as (...a: unknown[]) => void).apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest & { __readerTtUrl?: string },
    ...args: Parameters<XMLHttpRequest['send']>
  ) {
    const url = this.__readerTtUrl ?? '';
    if (url.indexOf('/api/timedtext') !== -1) {
      this.addEventListener('load', () => {
        try {
          stash(url, this.responseText ?? '');
        } catch {
          // responseType other than text — nothing to stash
        }
      });
    }
    return origSend.apply(this, args);
  };

  // Only ever unwind our own patches: if the page (or another extension) has
  // wrapped these since, restoring the originals would silently drop that
  // wrapper. Leaving ours in place is the lesser harm.
  const patchedFetch = window.fetch;
  const patchedOpen = XMLHttpRequest.prototype.open;
  const patchedSend = XMLHttpRequest.prototype.send;
  window.__readerTimedtextStop = () => {
    if (window.fetch === patchedFetch) window.fetch = origFetch;
    if (XMLHttpRequest.prototype.open === patchedOpen) XMLHttpRequest.prototype.open = origOpen;
    if (XMLHttpRequest.prototype.send === patchedSend) XMLHttpRequest.prototype.send = origSend;
    delete window.__readerTimedtext;
    delete window.__readerTimedtextStop;
  };
})();

export {};
