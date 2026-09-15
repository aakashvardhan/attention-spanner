import { useEffect, useMemo, useState } from 'react';
import { resumableItems, resumeContextFromProgress } from '../../shared/attention';
import { PAPERS_PAGE_PATH } from '../../shared/constants';
import { formatWatchTime } from '../../shared/format';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { useTheme } from '../../shared/hooks/useTheme';
import { sendMessage } from '../../shared/messages';
import { paperOpenUrl } from '../../shared/pdf';
import type { ResumeTarget } from '../../shared/types';
import { isWatchingNow, livePositionSeconds } from '../../shared/youtube';
import { BookmarksPanel } from './BookmarksPanel';

/**
 * The new tab: what you left unfinished, and the links you keep going back to.
 *
 * Deliberately two sections. Notes, tasks and planning live in Notion — this
 * page answers the one question the browser is actually in a position to
 * answer, which is "what did I start and not finish in here".
 */
export function Dashboard() {
  // initTheme() in main.tsx only resolves the theme once, at load. Without this
  // a skin or theme changed in Options never reaches an already-open new tab —
  // every other page in the extension subscribes.
  useTheme();
  const [readingProgress] = useStorageValue('readingProgress');
  const [papers] = useStorageValue('papers');

  const resumable = useMemo(
    () => resumableItems(readingProgress, papers),
    [readingProgress, papers],
  );

  // Ticks only while something is actually playing, so an idle new tab does
  // not re-render twice a second forever.
  const [watchingNow, setWatchingNow] = useState(() => Date.now());
  const anyWatching = resumable.some((i) => i.progress && isWatchingNow(i.progress, watchingNow));
  useEffect(() => {
    if (!anyWatching) return;
    const timer = setInterval(() => setWatchingNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [anyWatching]);

  return (
    <main className="relay">
      <header className="relay-header">
        <div>
          <p className="relay-eyebrow">Reader</p>
          <h1>Pick something back up</h1>
        </div>
        <div className="relay-header-right">
          <button
            className="relay-command"
            onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL(PAPERS_PAGE_PATH) })}
          >
            Papers
          </button>
          <button className="relay-command" onClick={() => void openSidePanel()}>
            Open panel
          </button>
        </div>
      </header>

      <section className="relay-continue" aria-labelledby="continue-title">
        <h2 id="continue-title">Continue reading</h2>
        {resumable.length === 0 ? (
          <p className="relay-empty">
            Nothing open right now. Press ⌘/Ctrl+Shift+E on any page to read it here.
          </p>
        ) : (
          <ul>
            {resumable.map((item) => (
              <li key={item.key}>
                <button
                  onClick={() => {
                    if (item.paper) {
                      void chrome.tabs.create({ url: paperOpenUrl(item.paper) });
                    } else if (item.progress) {
                      void openResume(resumeContextFromProgress(item.progress));
                    }
                  }}
                >
                  {item.title}
                  {/* A video playing in another tab is context, so it marks the
                      row it already occupies rather than earning a card. */}
                  {item.progress && isWatchingNow(item.progress, watchingNow) && (
                    <small className="relay-watching">
                      Watching · {formatWatchTime(livePositionSeconds(item.progress, watchingNow))}
                    </small>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <BookmarksPanel />
    </main>
  );
}

async function openResume(context: ResumeTarget) {
  if (context.kind === 'pdf' || context.kind === 'web') {
    await chrome.tabs.create({ url: context.url });
    return;
  }
  await sendMessage({
    type: 'OPEN_ARTICLE',
    url: context.url,
    feedItemId: null,
    resume: true,
  });
}

async function openSidePanel() {
  const window = await chrome.windows.getCurrent();
  if (window.id !== undefined) await chrome.sidePanel.open({ windowId: window.id });
}
