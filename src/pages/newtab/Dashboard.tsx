import { useEffect, useMemo, useRef, useState } from 'react';
import { resumableItems, resumeContextFromProgress } from '../../shared/attention';
import { useFocusSession } from '../../shared/hooks/useFocusSession';
import { useWatchClock } from '../../shared/hooks/useWatchClock';
import { useSettings } from '../../shared/hooks/useSettings';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { useTheme } from '../../shared/hooks/useTheme';
import { isTypingTarget } from '../../shared/keys';
import type { Pick } from '../../shared/llm/triage';
import { sendMessage, type Message } from '../../shared/messages';
import { paperOpenUrl } from '../../shared/pdf';
import type { ResumableItem } from '../../shared/attention';
import { ActivityHeatmap } from './ActivityHeatmap';
import { groupByCategory } from '../../shared/videoCategory';
import { BrainDump } from './BrainDump';
import { ContinueRow } from './ContinueRow';
import { EditionIndex } from './EditionIndex';
import { FocusTimer } from './FocusTimer';
import { TriageCard } from './TriageCard';

/**
 * The new tab as a front page. The lead story is
 * the newest thing you left unfinished and the page's one primary action
 * (Enter opens it); the sidebar is the feed triaged against what you finish;
 * the index along the bottom holds Papers, Settings and focus.
 *
 * It answers the one question the browser is in a position to answer — "what
 * did I start and not finish in here". Notes, tasks and planning live in
 * Notion, and nothing here keeps a list. J and K walk every story on the page.
 *
 * "Read this page" and "bookmark this page" are not here: from a new tab the
 * active tab is this page. The shortcut and the right-click items do that job.
 */
export function Dashboard() {
  // initTheme() in main.tsx only resolves the theme once, at load. Without this
  // a theme changed in Options never reaches an already-open new tab —
  // every other page in the extension subscribes.
  useTheme();
  const [readingProgress] = useStorageValue('readingProgress');
  const [papers] = useStorageValue('papers');
  const [settings] = useSettings();
  const focus = useFocusSession();
  /** Per group under the lead story: 'Continue reading' / 'Continue watching' show all */
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});

  // The focus and break themes (theme.css) key off the phase on <html>.
  useEffect(() => {
    const root = document.documentElement;
    if (focus.phase) root.dataset.phase = focus.phase;
    else delete root.dataset.phase;
  }, [focus.phase]);
  // How far through the focus round, in the dial's steps: the room's light follows it.
  const roundStep = focus.focusing ? focus.lit / focus.segments : null;
  useEffect(() => {
    const root = document.documentElement;
    if (roundStep === null) root.style.removeProperty('--round-progress');
    else root.style.setProperty('--round-progress', String(roundStep));
  }, [roundStep]);

  const resumable = useMemo(
    () => resumableItems(readingProgress, papers),
    [readingProgress, papers],
  );

  // One clock for the page: the Continue rows read their `now` off it.
  const watchingNow = useWatchClock();

  // One step in at a time: a second click while this tab navigates opens (and marks read) nothing.
  const steppingNow = useRef(false);
  const beginStep = () => {
    if (steppingNow.current) return false;
    steppingNow.current = true;
    return true;
  };
  const endStep = () => {
    steppingNow.current = false;
  };

  // Step in: the story's title is named for the view transition into the
  // reader's title, then this tab navigates.
  const stepInto = (url: string, from: Element | null) => {
    const title = from?.querySelector<HTMLElement>('.edition-headline, .relay-row-title, .edition-story-title');
    if (title) title.style.viewTransitionName = 'story-title';
    location.assign(url);
  };
  const lastStory = useRef<Element | null>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => (lastStory.current = (e.target as Element).closest('[data-story]'));
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  const openArticleHere = async (request: Omit<Extract<Message, { type: 'OPEN_ARTICLE' }>, 'type' | 'here'>, newTab: boolean) => {
    if (newTab) return void sendMessage({ type: 'OPEN_ARTICLE', ...request });
    if (!beginStep()) return;
    const res = await sendMessage({ type: 'OPEN_ARTICLE', ...request, here: true }).catch(() => null);
    // No URL: an open video tab was focused instead, or the open failed.
    if (res?.url) await stepInto(res.url, lastStory.current);
    else endStep();
  };

  const openPick = (pick: Pick, newTab: boolean) =>
    void openArticleHere(
      { url: pick.item.link, feedItemId: pick.item.id, readerView: false, original: true, alsoReadIds: pick.also.map((a) => a.id) },
      newTab,
    );

  const open = (item: ResumableItem, alt: boolean, newTab = false) => {
    if (item.paper) {
      const url = paperOpenUrl(item.paper, alt);
      if (newTab) void chrome.tabs.create({ url });
      else if (beginStep()) void stepInto(url, lastStory.current);
    } else if (item.progress) {
      const context = resumeContextFromProgress(item.progress);
      void openArticleHere({ url: context.url, feedItemId: null, resume: true, readerView: false }, newTab);
    }
  };

  // J/K walk every story on the page (lead, also-unfinished, feed); Enter with
  // nothing focused opens the selected one, which starts as the lead.
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === 'c' && !focus.active) {
        e.preventDefault();
        void focus.start(settings.focusMinutes);
        return;
      }
      const stories = [...document.querySelectorAll<HTMLElement>('[data-story]')];
      if (stories.length === 0) return;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        const next = Math.min(stories.length - 1, Math.max(0, selected + (e.key === 'j' ? 1 : -1)));
        stories[next].focus();
        setSelected(next);
      } else if (e.key === 'Enter' && document.activeElement === document.body) {
        e.preventDefault();
        stories[Math.min(selected, stories.length - 1)].click();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected, settings.focusMinutes, focus.active]);

  return (
    <main className="edition grid">
      <section className="edition-lead-col" aria-labelledby="continue-title">
        <h2 id="continue-title" className="visually-hidden">
          Pick back up
        </h2>
        {resumable.length === 0 ? (
          <p className="edition-notice">Nothing open. Press ⌘/Ctrl+Shift+E on any page to read it here.</p>
        ) : (
          <>
            <ul className="edition-lead-list">
              <ContinueRow
                lead
                selected={selected === 0}
                item={resumable[0]}
                now={watchingNow}
                onOpen={(alt, newTab) => open(resumable[0], alt, newTab)}
              />
            </ul>
            {resumable.length > 1 && (
              // Reading and watching are different moods; one mixed list made you
              // scan past videos for the article, so each gets its own column.
              <div className="edition-also">
                {(
                  [
                    ['Continue reading', resumable.slice(1).filter((item) => item.progress?.kind !== 'video')],
                    ['Continue watching', resumable.slice(1).filter((item) => item.progress?.kind === 'video')],
                  ] as const
                )
                  .filter(([, items]) => items.length > 0)
                  .map(([label, items]) => (
                    <section key={label} className="edition-also-group" aria-label={label}>
                      <p className="edition-kicker">{label}</p>
                      {/* Videos sort into what they are (Lecture series, AI, Robotics…); reading stays one list. */}
                      {(label === 'Continue watching'
                        ? groupByCategory(showAll[label] ? items : items.slice(0, GROUP_VISIBLE), (item) => [
                            item.title,
                            item.progress?.source ?? '',
                          ])
                        : [['', showAll[label] ? items : items.slice(0, GROUP_VISIBLE)] as [string, ResumableItem[]]]
                      ).map(([category, shown]) => (
                        <div key={category}>
                          {category && <p className="edition-also-category">{category}</p>}
                          <ul className="edition-also-list">
                            {shown.map((item) => (
                              <ContinueRow
                                key={item.key}
                                item={item}
                                now={watchingNow}
                                onOpen={(alt, newTab) => open(item, alt, newTab)}
                              />
                            ))}
                          </ul>
                        </div>
                      ))}
                      {items.length > GROUP_VISIBLE && (
                        <button
                          type="button"
                          className="relay-recap-toggle relay-more"
                          aria-expanded={Boolean(showAll[label])}
                          onClick={() => setShowAll((current) => ({ ...current, [label]: !current[label] }))}
                        >
                          {showAll[label] ? 'Show fewer' : `Show all ${items.length}`}
                        </button>
                      )}
                    </section>
                  ))}
              </div>
            )}
          </>
        )}
      </section>

      <aside className="edition-side">
        <FocusTimer focus={focus} />
        <BrainDump />
        {/* A focus round is no time for the feed. */}
        {!focus.focusing && <TriageCard onOpen={openPick} />}
      </aside>

      <ActivityHeatmap papers={papers} />

      <EditionIndex />
    </main>
  );
}

/** Rows per group before "Show all": enough to choose from, few enough to scan. */
const GROUP_VISIBLE = 5;

