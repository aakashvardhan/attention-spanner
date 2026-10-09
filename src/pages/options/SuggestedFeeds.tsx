import { useEffect, useRef, useState } from 'react';
import { SAMPLE_FEEDS } from '../../shared/constants';
import { DISCOVERY, fetchCapped, suggestFeeds, type DiscoveryResult } from '../../shared/feedDiscovery';

export type Scan =
  | { state: 'idle' }
  | { state: 'scanning' }
  | { state: 'done'; result: DiscoveryResult }
  | { state: 'denied' }
  | { state: 'error'; message: string };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The one line under the button. Pure, so every case is a unit test. */
export function statusText(scan: Scan): string {
  switch (scan.state) {
    case 'idle':
      return '';
    case 'scanning':
      return 'Checking the sites you visit most...';
    case 'denied':
      return 'Suggestions need access to your history. It is read on this computer only; nothing is stored or sent.';
    case 'error':
      return scan.message;
    case 'done': {
      const { suggestions, checked, unreachable } = scan.result;
      const sites = `${plural(checked, 'site', 'sites')} you visit most`;
      const missed = unreachable > 0 ? ` ${unreachable} couldn't be reached.` : '';
      if (checked === 0) return `Not enough browsing in the last ${DISCOVERY.days} days to suggest anything yet.`;
      if (suggestions.length > 0) return `Found ${plural(suggestions.length, 'feed', 'feeds')} on the ${sites}.${missed}`;
      if (unreachable === checked) return `Couldn't reach any of the ${sites}. Check your connection and try again.`;
      return `None of the ${sites} publish a feed.${missed}`;
    }
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Feeds from the sites you already visit, found on request. History is read
 * here, in the page, only after Chrome's permission prompt; nothing is kept.
 * The static sample feeds stay underneath for a fresh profile with no history.
 */
export function SuggestedFeeds({ feeds, onAdd }: { feeds: string[]; onAdd: (url: string) => Promise<string> }) {
  const [scan, setScan] = useState<Scan>({ state: 'idle' });
  // The outcome of the last chip clicked, said here rather than at the top of
  // the page where Add Feed's own message lives and nobody down here sees it.
  const [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null);

  // Leaving Settings mid-scan stops the fetches and every state update after it.
  useEffect(() => () => controller.current?.abort(), []);

  const run = async () => {
    // Chrome shows the permission prompt only inside the click, so this is the
    // first await. Re-asked every time: the grant can be revoked from
    // chrome://extensions between clicks.
    let granted: boolean;
    try {
      granted = await chrome.permissions.request({ permissions: ['history'] });
    } catch (error) {
      setScan({ state: 'error', message: `Chrome would not ask for history access: ${messageOf(error)}` });
      return;
    }
    if (!granted || !chrome.history) {
      setScan({ state: 'denied' });
      return;
    }
    if (!navigator.onLine) {
      setScan({ state: 'error', message: "You're offline. Connect and try again." });
      return;
    }
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    setNotice('');
    setScan({ state: 'scanning' });
    try {
      const result = await suggestFeeds(
        {
          now: Date.now,
          searchHistory: (startTime) => chrome.history.search({ text: '', startTime, maxResults: 10_000 }),
          fetchPage: fetchCapped,
        },
        feeds,
        ctrl.signal,
      );
      if (!ctrl.signal.aborted) setScan({ state: 'done', result });
    } catch (error) {
      if (ctrl.signal.aborted) return;
      setScan({ state: 'error', message: `Couldn't read your history: ${messageOf(error)}` });
    }
  };

  const cancel = () => {
    controller.current?.abort();
    setScan({ state: 'idle' });
  };

  const suggestions = scan.state === 'done' ? scan.result.suggestions : [];
  const scanning = scan.state === 'scanning';
  const add = (url: string) => void onAdd(url).then(setNotice);

  return (
    <section className="section" id="sample-feeds">
      <h2>Suggested Feeds</h2>
      <div className="suggest-row">
        {/* Stays put while scanning, so the second half of a double-click
            lands on a button that ignores it, never on Cancel. */}
        <button type="button" className="secondary-btn" aria-disabled={scanning} onClick={() => !scanning && void run()}>
          Suggest from my history
        </button>
        {scanning && (
          <button type="button" className="secondary-btn" onClick={cancel}>
            Cancel
          </button>
        )}
      </div>
      {/* Always mounted: a live region only announces changes it was present for. */}
      <p className="hint" role="status" aria-live="polite">
        {notice || statusText(scan)}
      </p>
      {suggestions.length > 0 && (
        <div className="sample-feeds" role="group" aria-label="From your history">
          {suggestions.map((s) => {
            const following = feeds.includes(s.feedUrl);
            return (
              // aria-disabled, not disabled: a disabled button drops keyboard
              // focus to <body> the moment the feed is added.
              <button
                type="button"
                key={s.feedUrl}
                className="sample-feed"
                aria-disabled={following}
                title={s.feedUrl}
                onClick={() => !following && add(s.feedUrl)}
              >
                {following ? `Following ${s.host}` : `${s.host} · visited ${s.visits} times`}
              </button>
            );
          })}
        </div>
      )}
      <p className="hint">Or start with a popular feed:</p>
      <div className="sample-feeds">
        {SAMPLE_FEEDS.map((feed) => (
          <button type="button" key={feed.url} className="sample-feed" onClick={() => add(feed.url)}>
            {feed.name}
          </button>
        ))}
      </div>
    </section>
  );
}
