import { useMemo } from 'react';
import { useFocusSession } from '../../shared/hooks/useFocusSession';

/**
 * Shown when a blocked site is hit while a paper is open in the reader. Renders
 * from storage only: when the session ends (the reader closes) the page
 * live-updates to a "continue" link, so blocked tabs release themselves.
 */
export function Blocked() {
  const focus = useFocusSession();

  const blockedUrl = useMemo(() => {
    const hash = location.hash.slice(1);
    if (!hash) return null;
    try {
      const url = new URL(hash);
      // This page is web-accessible, so any site can navigate here with a
      // fragment of its choosing; only http(s) may become a link.
      return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
    } catch {
      return null;
    }
  }, []);
  const host = blockedUrl?.hostname.replace(/^www\./, '');

  if (!focus.reading) {
    return (
      <main className="blocked grid">
        <div className="blocked-inner">
          <h1>Reading session over</h1>
          {blockedUrl ? (
            <a className="blocked-continue" href={blockedUrl.href}>
              Continue to {host}
            </a>
          ) : (
            <p className="blocked-sub">You're free to browse.</p>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="blocked grid">
      <div className="blocked-inner">
        <h1>{host ? `${host} is blocked while you read` : 'This site is blocked while you read'}</h1>
        {focus.title && <p className="blocked-intention">You're reading: {focus.title}</p>}
        <button type="button" className="blocked-continue" onClick={() => void focus.backToPaper()} autoFocus>
          Back to your paper
        </button>
        <p className="blocked-sub">Close the reader to end the session.</p>
      </div>
    </main>
  );
}
