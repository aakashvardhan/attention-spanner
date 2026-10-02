import { useEffect, useMemo, useRef, useState } from 'react';
import { resumableItems, resumeContextFromProgress } from '../../shared/attention';
import { PAPERS_PAGE_PATH } from '../../shared/constants';
import { useFocusSession } from '../../shared/hooks/useFocusSession';
import { useNowWatching } from '../../shared/hooks/useNowWatching';
import { useSettings } from '../../shared/hooks/useSettings';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { useTheme } from '../../shared/hooks/useTheme';
import { probePercent, settleProbes, updateStats } from '../../shared/llm/store';
import { sendMessage } from '../../shared/messages';
import { paperOpenUrl } from '../../shared/pdf';
import type { ResumeTarget } from '../../shared/types';
import { BookmarksPanel } from './BookmarksPanel';
import { ContinueRow } from './ContinueRow';
import { Hero } from './Hero';
import { CardTitle, Icon } from './Icon';
import { NowWatching } from './NowWatching';
import { TriageCard } from './TriageCard';

/**
 * The new tab: where you are right now, what you left unfinished, and the links
 * you keep going back to.
 *
 * The cards answer the one question the browser is actually in a position to
 * answer — "what did I start and not finish in here". The hero above them does
 * not try to be a second answer: it is a clock, a greeting, one sentence you
 * wrote this morning and a line to read. Notes, tasks and planning still live
 * in Notion, and nothing here keeps a list.
 *
 * This is now the only surface. The side panel used to hold the actions and the
 * Follow pane; both moved here when it went. Two of its actions did not come
 * with them — "read this page" and "bookmark this page" acted on the active
 * tab, and from a new tab the active tab is this page. The keyboard shortcut
 * and the two right-click items still do that job from the page it belongs on.
 */
export function Dashboard() {
  // initTheme() in main.tsx only resolves the theme once, at load. Without this
  // a skin or theme changed in Options never reaches an already-open new tab —
  // every other page in the extension subscribes.
  useTheme();
  const [readingProgress, progressLoaded] = useStorageValue('readingProgress');
  const [papers, papersLoaded] = useStorageValue('papers');
  const [settings] = useSettings();
  const focus = useFocusSession();
  const [showAll, setShowAll] = useState(false);

  // Score resume and triage probes whose outcome is now known (llm/store.ts).
  // Once per new tab: the counts behind Settings' "what it has done" rows.
  const settled = useRef(false);
  useEffect(() => {
    if (settled.current || !progressLoaded || !papersLoaded) return;
    settled.current = true;
    const percentOf = probePercent(readingProgress, papers);
    void updateStats((stats) => {
      const next = settleProbes(stats, percentOf, Date.now());
      return next.probes.length === stats.probes.length ? null : next;
    });
  }, [progressLoaded, papersLoaded, readingProgress, papers]);

  const resumable = useMemo(
    () => resumableItems(readingProgress, papers),
    [readingProgress, papers],
  );

  // One clock for the page. useNowWatching already ticks at 500ms while a video
  // is playing and stands still otherwise, so the Continue rows read their `now`
  // off it rather than starting a second interval against the same state.
  const watching = useNowWatching();
  const watchingNow = watching.now;

  return (
    <main className="relay">
      <Hero />

      {focus.active && (
        <div className="relay-focus-row">
          <span>
            <strong>Focus</strong>
            <small>{focus.countdown}</small>
          </span>
          <button className="relay-command" onClick={() => void focus.stop(true)}>
            Stop
          </button>
        </div>
      )}

      <div className="relay-commands">
        {/* Only the Start button is swapped out by a running session — Papers
            and Settings have nothing to do with focus and stay put. */}
        {!focus.active && (
          <button
            className="relay-command"
            onClick={() => void focus.start(settings.focusMinutes)}
          >
            <Icon name="timer" />
            Start {settings.focusMinutes}-minute focus
          </button>
        )}
        <button
          className="relay-command"
          onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL(PAPERS_PAGE_PATH) })}
        >
          <Icon name="papers" />
          Papers
        </button>
        <button className="relay-command" onClick={() => void chrome.runtime.openOptionsPage()}>
          <Icon name="settings" />
          Settings
        </button>
      </div>

      {/* Favorites first, as on Safari's start page: the one-click part of the
          page belongs above the lists you have to read to use. */}
      <BookmarksPanel />

      {watching.active && <NowWatching watching={watching} />}

      <div className="relay-columns">
        <section className="relay-continue" aria-labelledby="continue-title">
          {/* The old page put "Pick something back up" in an h1 above this card.
              The greeting is the h1 now, and this heading already said it. */}
          <CardTitle id="continue-title" icon="history">Pick something back up</CardTitle>
          {resumable.length === 0 ? (
            <p className="relay-empty">
              Nothing open right now. Press ⌘/Ctrl+Shift+E on any page to read it here.
            </p>
          ) : (
            <ul>
              {(showAll ? resumable : resumable.slice(0, RESUME_VISIBLE)).map((item) => (
                <ContinueRow
                  key={item.key}
                  item={item}
                  now={watchingNow}
                  onOpen={(alt) => {
                    if (item.paper) {
                      void chrome.tabs.create({ url: paperOpenUrl(item.paper, alt) });
                    } else if (item.progress) {
                      void openResume(resumeContextFromProgress(item.progress));
                    }
                  }}
                />
              ))}
            </ul>
          )}
          {resumable.length > RESUME_VISIBLE && (
            <button
              type="button"
              className="relay-recap-toggle relay-more"
              aria-expanded={showAll}
              onClick={() => setShowAll((current) => !current)}
            >
              {showAll ? 'Show fewer' : `Show all ${resumable.length}`}
            </button>
          )}
        </section>

        <TriageCard />
      </div>
    </main>
  );
}

/** Rows shown before "Show all": enough to choose from, few enough to scan. */
const RESUME_VISIBLE = 6;

async function openResume(context: ResumeTarget) {
  await sendMessage({
    type: 'OPEN_ARTICLE',
    url: context.url,
    feedItemId: null,
    resume: true,
    readerView: false,
  });
}
