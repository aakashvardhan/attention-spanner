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
import { openQuestions } from '../../shared/thinking';
import type { ResumableItem } from '../../shared/attention';
import { ActivityHeatmap } from './ActivityHeatmap';
import { BrainDump } from './BrainDump';
import { ContinueRow } from './ContinueRow';
import { DeckList } from './DeckList';
import { ShowAll } from './ShowAll';
import { EditionIndex } from './EditionIndex';
import { FocusTimer } from './FocusTimer';
import { TriageCard } from './TriageCard';
import { visibleRows } from './visibleRows';

/**
 * The new tab in two columns. Now, on the left: the Pomodoro clock, the brain
 * dump and the activity heatmap. Read, on the right: Continue (what you left
 * unfinished), Deck (open questions) and News (the feed triaged against what
 * you finish). The foot holds Papers and Settings.
 *
 * J and K walk every openable row on the page, Enter opens the selected one,
 * C clocks in. "Read this page" is not here: from a new tab the active tab is
 * this page. The shortcut and the right-click item do that job.
 */
export function Dashboard() {
  // initTheme() in main.tsx only resolves the theme once, at load. Without this
  // a theme changed in Options never reaches an already-open new tab —
  // every other page in the extension subscribes.
  useTheme();
  const [readingProgress] = useStorageValue('readingProgress');
  const [papers] = useStorageValue('papers');
  const [annotations] = useStorageValue('annotations');
  const [provocations] = useStorageValue('provocations');
  const [settings] = useSettings();
  const focus = useFocusSession();
  /** Per Continue sub-list ('reading' / 'watching'): showing all of it */
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
  // Reading and watching are different moods: one mixed list made you scan
  // past videos for the article, so each gets its own short list.
  const groups = [
    ['reading', 'Reading', resumable.filter((item) => item.progress?.kind !== 'video')],
    ['watching', 'Watching', resumable.filter((item) => item.progress?.kind === 'video')],
  ] as const;
  const deck = useMemo(() => openQuestions(papers, annotations, provocations), [papers, annotations, provocations]);

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
    const title = from?.querySelector<HTMLElement>('.row-title');
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

  // J/K walk every row on the page (Continue, Deck, News); Enter with nothing
  // focused opens the selected one, which starts as the first.
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
    <main className="edition">
      <div className="now-col">
        <FocusTimer focus={focus} />
        <BrainDump />
        <ActivityHeatmap papers={papers} />
      </div>

      <div className="read-col">
        <section className="read-section" aria-label="Continue">
          <h2 className="label">Continue</h2>
          {resumable.length === 0 ? (
            <p className="hint">Nothing open. Press ⌘/Ctrl+Shift+E on any page to read it here.</p>
          ) : (
            groups
              .filter(([, , items]) => items.length > 0)
              .map(([key, label, items]) => {
                const { shown, hidden } = visibleRows(items, Boolean(showAll[key]));
                return (
                  <section key={key} className="sublist" aria-label={`Continue ${key}`}>
                    <h3 className="sublabel">{label}</h3>
                    <ul>
                      {shown.map((item) => (
                        <ContinueRow
                          key={item.key}
                          item={item}
                          now={watchingNow}
                          onOpen={(alt, newTab) => open(item, alt, newTab)}
                        />
                      ))}
                    </ul>
                    <ShowAll
                      total={items.length}
                      hidden={hidden}
                      expanded={Boolean(showAll[key])}
                      onToggle={() => setShowAll((current) => ({ ...current, [key]: !current[key] }))}
                    />
                  </section>
                );
              })
          )}
        </section>
        <DeckList items={deck} />
        {/* A focus round is no time for the feed. */}
        {!focus.focusing && <TriageCard onOpen={openPick} />}
      </div>

      <EditionIndex />
    </main>
  );
}
