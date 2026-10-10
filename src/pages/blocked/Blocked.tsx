import { useMemo } from 'react';
import { HoldToQuit } from '../../shared/components/HoldToQuit';
import { useFocusSession } from '../../shared/hooks/useFocusSession';

/**
 * Shown when a blocked site is hit during focus. Zero SW dependency —
 * everything renders from storage, and when the session ends the page
 * live-updates to a "continue" link (blocked tabs
 * self-release; no tab bookkeeping in the worker).
 */
export function Blocked() {
  const focus = useFocusSession();

  const blockedUrl = useMemo(() => {
    const hash = location.hash.slice(1);
    if (!hash) return null;
    try {
      const url = new URL(hash);
      // This page is web-accessible, so any site can navigate the user here
      // with a fragment of its choosing. `new URL` accepts javascript: and
      // data: as readily as https, and the href below is rendered as a link
      // in an extension-origin page — only http(s) may become one.
      return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
    } catch {
      return null;
    }
  }, []);
  const host = blockedUrl?.hostname.replace(/^www\./, '');

  if (!focus.active) {
    return (
      <div className="blocked grid">
        <div className="blocked-inner">
          <h1>Focus session over</h1>
          {blockedUrl ? (
            <a className="blocked-continue" href={blockedUrl.href}>
              Continue to {host} →
            </a>
          ) : (
            <p className="blocked-sub">You're free to browse.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="blocked grid">
      <div className="blocked-inner">
        <p className="blocked-telemetry">OBSTACLE · {host ?? 'this site'} · PATH BLOCKED</p>
        <svg className="blocked-robot" viewBox="0 0 240 72" aria-hidden="true">
          <line className="blocked-ground" x1="0" y1="64" x2="240" y2="64" />
          <rect className="blocked-wall" x="148" y="20" width="16" height="44" />
          <path className="blocked-detour" d="M104 60 Q136 0 184 60" />
          <g className="blocked-bot">
            <rect x="72" y="40" width="20" height="16" rx="4" />
            <circle cx="82" cy="48" r="2.5" />
            <line x1="82" y1="40" x2="82" y2="32" />
            <line x1="76" y1="56" x2="76" y2="64" />
            <line x1="88" y1="56" x2="88" y2="64" />
          </g>
        </svg>
        <h1>{host ? `${host} is blocked` : 'This site is blocked'}</h1>
        <p className="blocked-sub">Focus mode — back off in</p>
        <p className="blocked-countdown">{focus.countdown}</p>

        <div className="blocked-quit">
          <HoldToQuit label="Hold 5s to end focus early" onConfirm={() => void focus.stop(true)} />
        </div>
      </div>
    </div>
  );
}
