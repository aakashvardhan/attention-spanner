import { useEffect, useMemo, useRef, useState } from 'react';
import { resumableItems, resumeContextFromProgress } from '../../shared/attention';
import { localDate } from '../../shared/format';
import { useFocusSession } from '../../shared/hooks/useFocusSession';
import { useMedia } from '../../shared/hooks/useMedia';
import { useNowWatching } from '../../shared/hooks/useNowWatching';
import { useSettings } from '../../shared/hooks/useSettings';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { useTheme } from '../../shared/hooks/useTheme';
import { isTypingTarget } from '../../shared/keys';
import { probePercent, settleProbes, updateStats } from '../../shared/llm/store';
import { muteMatcher, unreadItems, type Pick } from '../../shared/llm/triage';
import { sendMessage, type Message } from '../../shared/messages';
import { paperOpenUrl } from '../../shared/pdf';
import { patchSettings } from '../../shared/storage';
import type { ResumableItem } from '../../shared/attention';
import { ActivityHeatmap } from './ActivityHeatmap';
import { BrainDump } from './BrainDump';
import { ContinueRow } from './ContinueRow';
import { EditionIndex } from './EditionIndex';
import { Hero } from './Hero';
import { NowWatching } from './NowWatching';
import { quoteOfDay } from './quotes';
import { TriageCard } from './TriageCard';
import { World } from './world/World';
import { NARROW_QUERY, REDUCED_QUERY, tokenMs, viewMode } from './world/view';

/**
 * The new tab as a front page. The masthead is the greeting; the lead story is
 * the newest thing you left unfinished and the page's one primary action
 * (Enter opens it); the sidebar is the feed triaged against what you finish;
 * the index along the bottom holds favorites, Papers, Settings and focus.
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
  const [readingProgress, progressLoaded] = useStorageValue('readingProgress');
  const [papers, papersLoaded] = useStorageValue('papers');
  const [settings] = useSettings();
  const focus = useFocusSession();
  const [showAll, setShowAll] = useState(false);
  const [cachedItems] = useStorageValue('cachedItems');
  const [readItems] = useStorageValue('readItems');

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

  // Counts what the feed card can show: muted topics are not "new" to you.
  const isMuted = useMemo(() => muteMatcher(settings.mutedTopics), [settings.mutedTopics]);
  const visibleItems = cachedItems.filter((item) => !isMuted(item));
  const unreadCount = unreadItems(visibleItems, readItems, visibleItems.length).length;
  const status = [
    resumable.length ? `${resumable.length} unfinished` : null,
    unreadCount ? `${unreadCount} new in your feeds` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const reduced = useMedia(REDUCED_QUERY);
  const narrow = useMedia(NARROW_QUERY);
  const view = viewMode(settings.worldView, reduced, narrow);
  const [stepping, setStepping] = useState(false);
  const quote = quoteOfDay(localDate());

  // Step in: the camera dollies forward, the story's title is named for the
  // view transition into the reader's title, then this tab navigates. A cut
  // (Comfortable, or the flat view) skips the dolly's wait.
  const stepInto = async (url: string, from: Element | null) => {
    const title = from?.querySelector<HTMLElement>('.edition-headline, .relay-row-title, .edition-story-title');
    if (title) title.style.viewTransitionName = 'story-title';
    setStepping(true);
    const glide = view === 'world' && settings.comfort === 'recommended';
    await new Promise((r) => setTimeout(r, glide ? tokenMs('--dur-smooth') : 0));
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
    const res = await sendMessage({ type: 'OPEN_ARTICLE', ...request, here: true });
    if (res?.url) await stepInto(res.url, lastStory.current);
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
      else void stepInto(url, lastStory.current);
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
      if (e.key === 'v' && !reduced && !narrow) {
        e.preventDefault();
        void patchSettings({ worldView: settings.worldView === 'world' ? 'flat' : 'world' });
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
  }, [selected, settings.worldView, reduced, narrow]);

  if (view === 'world') {
    return (
      <World
        status={status}
        resumable={resumable}
        now={watchingNow}
        watching={watching}
        papers={papers}
        focus={focus}
        settings={settings}
        quote={quote}
        stepping={stepping}
        onOpen={open}
        onOpenPick={openPick}
      />
    );
  }

  return (
    <main className="edition grid">
      <Hero status={status} />

      {watching.active && <NowWatching watching={watching} />}

      <section className="edition-lead-col" aria-labelledby="continue-title">
        <h2 id="continue-title" className="visually-hidden">
          Continue reading
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
              <>
                <p className="edition-kicker edition-also">Also unfinished</p>
                <ul className="edition-also-list">
                  {(showAll ? resumable.slice(1) : resumable.slice(1, RESUME_VISIBLE)).map((item) => (
                    <ContinueRow key={item.key} item={item} now={watchingNow} onOpen={(alt, newTab) => open(item, alt, newTab)} />
                  ))}
                </ul>
              </>
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
          </>
        )}
      </section>

      <aside className="edition-side">
        <BrainDump />
        <TriageCard onOpen={openPick} />
        <p className="edition-quote">{quote}</p>
      </aside>

      <ActivityHeatmap papers={papers} />

      <EditionIndex />
    </main>
  );
}

/** Rows shown before "Show all": enough to choose from, few enough to scan. */
const RESUME_VISIBLE = 6;

