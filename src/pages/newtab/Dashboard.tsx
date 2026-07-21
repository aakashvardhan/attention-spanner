import { useEffect, useMemo, useState } from 'react';
import { runPendingAutomations } from '../../shared/ai/automations';
import { maybeGenerateBriefing } from '../../shared/ai/briefing';
import { nanoProvider } from '../../shared/ai/nanoProvider';
import { BADGES } from '../../shared/badges';
import {
  currentEvent,
  formatCountdown,
  nextUpcoming,
  todayEvents,
} from '../../shared/calendar';
import { AssistantChat } from '../../shared/components/AssistantChat';
import { BrainDump } from '../../shared/components/BrainDump';
import { HoldToQuit } from '../../shared/components/HoldToQuit';
import { IgnitionCard } from '../../shared/components/IgnitionCard';
import { NotesHistory } from '../../shared/components/NotesHistory';
import { SortableTaskList } from '../../shared/components/SortableTaskList';
import {
  FLASHCARDS_PAGE_PATH,
  FOCUS_PRESETS,
  MAX_LIST_ITEMS,
  PAPERS_PAGE_PATH,
} from '../../shared/constants';
import { useFocusSession } from '../../shared/hooks/useFocusSession';
import {
  daysAgo,
  faviconUrl,
  formatRelativeDate,
  formatTime,
  formatWatchTime,
  localDate,
} from '../../shared/format';
import { useBookmarks } from '../../shared/hooks/useBookmarks';
import { useFeed } from '../../shared/hooks/useFeed';
import { usePapers } from '../../shared/hooks/usePapers';
import { useSprint } from '../../shared/hooks/useSprint';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { useTasks } from '../../shared/hooks/useTasks';
import { useTheme } from '../../shared/hooks/useTheme';
import { levelForXp } from '../../shared/levels';
import { sendMessage } from '../../shared/messages';
import { questProgress } from '../../shared/quest';
import { dueCounts, newIntroducedToday, totalDue } from '../../shared/srs';
import { DEFAULT_SETTINGS, patchSettings } from '../../shared/storage';
import type { Paper, Task } from '../../shared/types';
import { paperOpenUrl } from '../../shared/pdf';
import { weekDates, weekKey } from '../../shared/week';
import type { MeetingNote } from '../../shared/meetingNotes';
import { ActivityCalendar } from './ActivityCalendar';
import { CommandPalette } from './CommandPalette';
import { DashboardGrid, type DashCard } from './DashboardGrid';
import { MeetingNoteReader } from './MeetingNoteReader';
import { WarmupPanel } from './WarmupPanel';

const DASHBOARD_CARDS: readonly DashCard[] = [
  { id: 'feeds', title: '📰 Feeds', Component: FeedsPanel },
  { id: 'agenda', title: '📅 Today', Component: AgendaPanel },
  { id: 'links', title: '🔗 Links', Component: BookmarksPanel },
  { id: 'tasks', title: '📝 Tasks', Component: TaskPanel },
  { id: 'continue', title: '📖 Continue', Component: ContinuePanel },
  { id: 'streak', title: '🔥 Focus', Component: StreakPanel },
  { id: 'gym', title: '💪 Gym', Component: GymPanel },
  { id: 'progress', title: '🏆 Progress', Component: GamificationPanel },
  { id: 'braindump', title: '🧠 Brain dump', Component: BrainDumpPanel },
  { id: 'flashcards', title: '🃏 Flashcards', Component: FlashcardsPanel },
  { id: 'papers', title: '📄 Papers', Component: PapersPanel },
  { id: 'meetings', title: '🗓️ Meetings', Component: MeetingNotesPanel },
  { id: 'warmup', title: '⚡ Warm-up', Component: WarmupPanel },
];

export function Dashboard() {
  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Up late?' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const focus = useFocusSession();
  const inFocus = focus.active && focus.phase === 'focus';
  const theme = useTheme();
  const [storedSettings] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };

  useEffect(() => {
    document.body.classList.toggle('focus-active', inFocus);
    return () => document.body.classList.remove('focus-active');
  }, [inFocus]);

  useEffect(() => {
    void maybeGenerateBriefing();
    // Automations queued while no cloud key was reachable run on-device here
    void runPendingAutomations(nanoProvider);
  }, []);

  return (
    <div className="dashboard">
      <CommandPalette />
      {inFocus && <FocusBanner focus={focus} />}
      <div className="dash-topbar">
        <header className="dash-header">
          <div>
            <h1>{greeting}.</h1>
            <p className="dash-date">
              {new Date().toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })}
            </p>
          </div>
          <div className="dash-header-right">
            <button
              className="ghost-btn theme-toggle"
              title={theme.resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              onClick={() => theme.setMode(theme.resolved === 'dark' ? 'light' : 'dark')}
            >
              {theme.resolved === 'dark' ? '☀️' : '🌙'}
            </button>
            <Clock />
          </div>
        </header>
        <ActivityCalendar />
      </div>
      <DashboardGrid cards={DASHBOARD_CARDS} />
      {/* Headless: the wake-word handoff runs only on a non-compact AssistantChat.
          The visible assistant now lives in the popup, so mount a hidden one here
          to keep "Hey Jarvis" commands executing when the setting is on. */}
      {settings.assistantWakeWordEnabled && (
        <div className="sr-only">
          <AssistantChat />
        </div>
      )}
    </div>
  );
}

function FeedsPanel() {
  const feed = useFeed();
  const [filter, setFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const sources = useMemo(
    () => [...new Set(feed.items.map((item) => item.source))].sort(),
    [feed.items],
  );
  const categories = useMemo(
    () => [...new Set(feed.items.flatMap((item) => item.categories ?? []))].sort(),
    [feed.items],
  );
  const effectiveFilter = filter !== 'all' && !sources.includes(filter) ? 'all' : filter;
  const effectiveCategory =
    categoryFilter !== 'all' && !categories.includes(categoryFilter) ? 'all' : categoryFilter;
  const query = search.trim().toLowerCase();

  const filtered = feed.items.filter((item) => {
    if (effectiveFilter !== 'all' && item.source !== effectiveFilter) return false;
    if (effectiveCategory !== 'all' && !(item.categories ?? []).includes(effectiveCategory))
      return false;
    if (unreadOnly && feed.readItems.includes(item.id)) return false;
    if (
      query &&
      !`${item.title} ${item.snippet} ${item.source}`.toLowerCase().includes(query)
    )
      return false;
    return true;
  });

  const hasFilters = query !== '' || unreadOnly || effectiveFilter !== 'all' || effectiveCategory !== 'all';

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>📰 Feeds</h2>
        <button
          className="ghost-btn"
          title="Refresh feeds"
          onClick={() => void feed.refresh()}
          disabled={feed.refreshing}
        >
          ↻
        </button>
      </div>

      {feed.items.length > 0 && (
        <div className="dash-feed-filters">
          <input
            type="search"
            className="dash-feed-search"
            placeholder="Search articles…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {sources.length > 1 && (
            <select
              className="dash-feed-filter"
              value={effectiveFilter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">All feeds ({feed.items.length})</option>
              {sources.map((source) => (
                <option key={source} value={source}>
                  {source} ({feed.items.filter((item) => item.source === source).length})
                </option>
              ))}
            </select>
          )}
          {categories.length > 0 && (
            <select
              className="dash-feed-filter"
              value={effectiveCategory}
              onChange={(e) => setCategoryFilter(e.target.value)}
            >
              <option value="all">All topics</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          )}
          <button
            className={unreadOnly ? 'dash-feed-toggle active' : 'dash-feed-toggle'}
            aria-pressed={unreadOnly}
            title="Show unread only"
            onClick={() => setUnreadOnly((v) => !v)}
          >
            Unread
          </button>
        </div>
      )}

      <div className="panel-scroll">
        {feed.feeds.length === 0 ? (
          <p className="panel-empty">
            No feeds yet.{' '}
            <button className="link-btn" onClick={() => chrome.runtime.openOptionsPage()}>
              Add a feed
            </button>
          </p>
        ) : filtered.length === 0 ? (
          <p className="panel-empty">
            {feed.refreshing
              ? 'Loading feeds…'
              : hasFilters
                ? 'No items match your filters.'
                : 'No items — try refreshing.'}
          </p>
        ) : (
          filtered.slice(0, MAX_LIST_ITEMS).map((item) => {
            const read = feed.readItems.includes(item.id);
            return (
              <div
                key={item.id}
                className={read ? 'dash-article read' : 'dash-article'}
                onClick={() =>
                  void sendMessage({
                    type: 'OPEN_ARTICLE',
                    url: item.link,
                    feedItemId: item.id,
                    resume: false,
                  })
                }
              >
                <div className="dash-article-top">
                  <span className="dash-article-title">{item.title}</span>
                </div>
                <span className="dash-article-meta">
                  {item.source} · {formatRelativeDate(new Date(item.pubDate))}
                </span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

function AgendaPanel() {
  const [calendar] = useStorageValue('calendar');
  const [now, setNow] = useState(() => new Date());
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    // Throttled server-side; a fresh cache makes this a no-op
    void sendMessage({ type: 'CAL_REFRESH' });
  }, []);

  const configured = Boolean(chrome.runtime.getManifest().oauth2?.client_id);

  const connect = async () => {
    setConnecting(true);
    setConnectError(null);
    const res = await sendMessage({ type: 'CAL_SIGN_IN' });
    if (!res.ok) setConnectError(res.error ?? 'Google sign-in failed.');
    setConnecting(false);
  };

  if (!configured) {
    return (
      <section className="panel">
        <h2>📅 Today</h2>
        <p className="panel-empty">
          Google Calendar isn't configured for this build — see
          docs/google-calendar-setup.md to enable it.
        </p>
      </section>
    );
  }

  if (!calendar.connected) {
    return (
      <section className="panel">
        <h2>📅 Today</h2>
        <p className="panel-empty">See your day's events here and let the assistant block time.</p>
        {(connectError ?? calendar.lastError) && (
          <p className="ag-error">{connectError ?? calendar.lastError}</p>
        )}
        <button className="sprint-start" disabled={connecting} onClick={() => void connect()}>
          {connecting ? 'Connecting…' : 'Connect Google Calendar'}
        </button>
      </section>
    );
  }

  const today = todayEvents(calendar.events, now);
  const current = currentEvent(today, now);
  const next = nextUpcoming(today, now);
  const timeOf = (ms: number) =>
    new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  return (
    <section className="panel">
      <h2>📅 Today</h2>
      {next ? (
        <p className="ag-next">
          {next.event.title} <span className="ag-countdown">{formatCountdown(next.minutesUntil)}</span>
        </p>
      ) : current ? (
        <p className="ag-next">
          {current.title} <span className="ag-countdown">now</span>
        </p>
      ) : (
        <p className="ag-next ag-clear">No more events — clear runway. 🛫</p>
      )}
      <div className="panel-scroll">
        {today.length === 0 && <p className="panel-empty">Nothing scheduled today.</p>}
        {today.map((event) => (
          <a
            key={event.id}
            className={
              event === current
                ? 'ag-event current'
                : event.endMs <= now.getTime() && !event.allDay
                  ? 'ag-event past'
                  : 'ag-event'
            }
            href={event.htmlLink || undefined}
            target="_blank"
            rel="noreferrer"
          >
            <span className="ag-time">
              {event.allDay ? 'all day' : `${timeOf(event.startMs)}–${timeOf(event.endMs)}`}
            </span>
            <span className="ag-title">{event.title}</span>
            {event.hangoutLink && (
              <button
                className="ag-join"
                onClick={(e) => {
                  e.preventDefault();
                  void chrome.tabs.create({ url: event.hangoutLink });
                }}
              >
                Join
              </button>
            )}
          </a>
        ))}
      </div>
      {calendar.lastError && <p className="ag-error">{calendar.lastError}</p>}
    </section>
  );
}

function MeetingNotesPanel() {
  const [state] = useStorageValue('meetingNotes');
  const [settings] = useStorageValue('settings');
  const [readerNote, setReaderNote] = useState<MeetingNote | null>(null);

  useEffect(() => {
    // Throttled server-side; a fresh cache makes this a no-op
    void sendMessage({ type: 'MEETING_NOTES_REFRESH' });
  }, []);

  const configured = settings.notionToken !== '' && settings.notionMeetingNotesDbId !== '';

  if (!configured) {
    return (
      <section className="panel">
        <h2>🗓️ Meetings</h2>
        <p className="panel-empty">
          Pull your Notion meeting notes here — pick a database in Settings → Notion Sync.
        </p>
        <button className="sprint-start" onClick={() => void chrome.runtime.openOptionsPage()}>
          Open Settings
        </button>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>🗓️ Meetings</h2>
      <div className="panel-scroll">
        {state.notes.length === 0 && <p className="panel-empty">No notes yet.</p>}
        {state.notes.map((note) => (
          <button key={note.id} className="mn-row" onClick={() => setReaderNote(note)}>
            <span className="mn-row-title">{note.title}</span>
            <span className="mn-date">{formatRelativeDate(new Date(note.dateMs))}</span>
          </button>
        ))}
      </div>
      {state.lastError && <p className="ag-error">{state.lastError}</p>}
      {readerNote && <MeetingNoteReader note={readerNote} onClose={() => setReaderNote(null)} />}
    </section>
  );
}

function BookmarksPanel() {
  const bm = useBookmarks();
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [groupChoice, setGroupChoice] = useState<string>('unsorted');
  const [newGroupName, setNewGroupName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    let normalized = url.trim();
    if (!normalized) return;
    if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;
    try {
      new URL(normalized);
    } catch {
      setError('Not a valid URL.');
      return;
    }
    setError(null);

    let groupId: string | null = groupChoice === 'unsorted' ? null : groupChoice;
    if (groupChoice === 'new') {
      if (!newGroupName.trim()) {
        setError('Name the new group first.');
        return;
      }
      const res = await bm.addGroup(newGroupName.trim());
      groupId = res.group.id;
      setGroupChoice(res.group.id);
      setNewGroupName('');
    }
    await bm.addBookmark(normalized, title.trim(), groupId);
    setUrl('');
    setTitle('');
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>🔗 Links</h2>
        <button
          className={editing ? 'ghost-btn editing' : 'ghost-btn'}
          title={editing ? 'Done editing' : 'Edit links'}
          onClick={() => setEditing((e) => !e)}
        >
          {editing ? 'Done' : '✎'}
        </button>
      </div>

      <div className="panel-scroll">
        {bm.grouped.length === 0 && (
          <p className="panel-empty">No links yet — add your go-to sites below.</p>
        )}
        {bm.grouped.map((section) => (
          <div key={section.id ?? 'unsorted'} className="bm-group">
            <p className="row-label bm-group-head">
              {section.name}
              {editing && section.id !== null && (
                <button
                  className="ghost-btn"
                  title="Delete group (links move to Unsorted)"
                  onClick={() => {
                    if (window.confirm(`Delete group "${section.name}"? Its links move to Unsorted.`)) {
                      void bm.deleteGroup(section.id!);
                    }
                  }}
                >
                  ✕
                </button>
              )}
            </p>
            <div className="bm-grid">
              {section.links.map((link) => (
                <div key={link.id} className="bm-tile-wrap">
                  <a className="bm-tile" href={link.url} title={link.url}>
                    <BookmarkIcon url={link.url} title={link.title} />
                    <span className="bm-name">{link.title}</span>
                  </a>
                  {editing && (
                    <div className="bm-edit">
                      <select
                        value={link.groupId ?? 'unsorted'}
                        onChange={(e) =>
                          void bm.moveBookmark(
                            link.id,
                            e.target.value === 'unsorted' ? null : e.target.value,
                          )
                        }
                      >
                        {bm.groups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                        <option value="unsorted">Unsorted</option>
                      </select>
                      <button
                        className="ghost-btn"
                        title="Delete link"
                        onClick={() => void bm.deleteBookmark(link.id)}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <form
        className="bm-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a URL…"
        />
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Name (optional)"
        />
        <div className="bm-add-row">
          <select value={groupChoice} onChange={(e) => setGroupChoice(e.target.value)}>
            {bm.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
            <option value="unsorted">Unsorted</option>
            <option value="new">＋ New group…</option>
          </select>
          {groupChoice === 'new' && (
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="Group name"
              maxLength={40}
            />
          )}
          <button type="submit" className="bm-add-btn" disabled={!url.trim()}>
            Add
          </button>
        </div>
        {error && <p className="bm-error">{error}</p>}
      </form>
    </section>
  );
}

function BookmarkIcon({ url, title }: { url: string; title: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <span className="bm-letter">{(title[0] ?? '?').toUpperCase()}</span>;
  }
  return (
    <img
      className="bm-favicon"
      src={faviconUrl(url, 64)}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}

function FocusBanner({ focus }: { focus: ReturnType<typeof useFocusSession> }) {
  const [storedSettings] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };

  return (
    <div className="focus-banner">
      <p className="focus-banner-label">
        🎯 Focus — {settings.focusBlocklist.length} sites blocked
        {focus.session?.mode === 'pomodoro' && ` · block ${focus.completedBlocks + 1}`}
        {focus.session?.intent && (
          <span className="focus-banner-intent"> · {focus.session.intent}</span>
        )}
      </p>
      <p className="focus-banner-countdown">{focus.countdown}</p>
      <HoldToQuit label="Hold 5s to end early" onConfirm={() => void focus.stop(true)} />
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const [time, meridiem] = formatTime(now).split(' ');
  return (
    <div className="dash-clock" title={now.toLocaleTimeString()}>
      {time}
      <span className="dash-clock-meridiem">{meridiem}</span>
    </div>
  );
}

function GymPanel() {
  const [gym] = useStorageValue('gym');
  const [storedSettings] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };

  const today = localDate();
  const checkedInToday = today in gym.checkins;
  const thisWeek = weekDates(weekKey());
  const weekCount = thisWeek.filter((date) => date in gym.checkins).length;

  return (
    <section className="panel">
      <h2>💪 Gym</h2>
      <div className="streak-numbers">
        <div className="streak-stat">
          <span className="streak-value">{gym.currentWeekStreak}</span>
          <span className="streak-label">week streak</span>
        </div>
        <div className="streak-stat">
          <span className="streak-value">{gym.longestWeekStreak}</span>
          <span className="streak-label">longest</span>
        </div>
        <div className="streak-stat">
          <span className="streak-value">
            {weekCount}/{settings.gymWeeklyTarget}
          </span>
          <span className="streak-label">this week</span>
        </div>
      </div>

      <div className="heatmap" title={`Goal: ${settings.gymWeeklyTarget} sessions per week`}>
        {thisWeek.map((date, i) => (
          <div key={date} className="heat-col">
            <div
              className={date in gym.checkins ? 'heat-cell qualified' : 'heat-cell'}
              title={date}
            />
            <span className="heat-label">{'MTWTFSS'[i]}</span>
          </div>
        ))}
      </div>

      {checkedInToday ? (
        <div className="sprint-live">
          <p className="gym-logged">Logged for today ✔</p>
          <button
            className="sprint-cancel"
            onClick={() => void sendMessage({ type: 'GYM_UNDO' })}
          >
            undo
          </button>
        </div>
      ) : (
        <button
          className="sprint-start"
          onClick={() => void sendMessage({ type: 'GYM_CHECKIN' })}
        >
          💪 I went today
        </button>
      )}
    </section>
  );
}

function GamificationPanel() {
  const [gamification] = useStorageValue('gamification');
  const [gym] = useStorageValue('gym');
  const [streaks] = useStorageValue('streaks');
  const [storedSettings] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };

  const { level, intoLevel, toNext } = levelForXp(gamification.xp);
  const quest = questProgress(gym.checkins, streaks.daily, settings);

  return (
    <section className="panel">
      <h2>🏆 Progress</h2>

      <div className="level-row">
        <span className="level-title">Level {level}</span>
        <span className="level-xp">
          {intoLevel} / {toNext} XP
        </span>
      </div>
      <div className="dash-bar">
        <div className="dash-bar-fill" style={{ width: `${(intoLevel / toNext) * 100}%` }} />
      </div>

      <div className="quest-card">
        <p className="row-label">This week's quest</p>
        {quest.lines.map((line) => (
          <div key={line.key} className="quest-line">
            <span className="quest-label">
              {line.emoji} {line.label}
            </span>
            <div className="quest-bar">
              <div
                className="quest-bar-fill"
                style={{ width: `${Math.min(100, (line.current / line.target) * 100)}%` }}
              />
            </div>
            <span className="quest-count">
              {Math.min(line.current, line.target)}/{line.target}
            </span>
          </div>
        ))}
        {quest.complete && <p className="quest-done">Quest complete 🎉 +50 XP</p>}
      </div>

      <p className="row-label">Trophies</p>
      <div className="badge-grid">
        {BADGES.map((badge) => {
          const unlockedAt = gamification.badges[badge.id];
          return (
            <div
              key={badge.id}
              className={unlockedAt ? 'badge-tile unlocked' : 'badge-tile'}
              title={
                unlockedAt
                  ? `${badge.title} — unlocked ${new Date(unlockedAt).toLocaleDateString()}`
                  : `${badge.title} — ${badge.description}`
              }
            >
              <span className="badge-emoji">{badge.emoji}</span>
              <span className="badge-name">{badge.title}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BrainDumpPanel() {
  return (
    <section className="panel">
      <h2>🧠 Brain dump</h2>
      <BrainDump source="newtab" />
      <div className="panel-scroll">
        <NotesHistory />
      </div>
    </section>
  );
}

function FlashcardsPanel() {
  const [decks] = useStorageValue('decks');
  const [flashCards] = useStorageValue('flashCards');
  const [srsDaily] = useStorageValue('srsDaily');

  const counts = dueCounts(flashCards, Date.now(), newIntroducedToday(srsDaily, localDate()));
  const due = totalDue(counts);
  const deckDue = (id: string) => {
    const c = counts[id];
    return c ? c.newCount + c.learningCount + c.reviewCount : 0;
  };
  const topDecks = decks
    .filter((deck) => (deck.kind ?? 'flashcards') === 'flashcards')
    .map((deck) => ({ deck, due: deckDue(deck.id) }))
    .sort((a, b) => b.due - a.due)
    .slice(0, 3);
  const open = (hash = '') =>
    void chrome.tabs.create({ url: chrome.runtime.getURL(FLASHCARDS_PAGE_PATH) + hash });

  return (
    <section className="panel">
      <h2>🃏 Flashcards</h2>
      {decks.length === 0 ? (
        <p className="panel-empty">No decks yet — create one to start studying.</p>
      ) : (
        <>
          <div className="streak-numbers">
            <div className="streak-stat">
              <span className="streak-value">{due}</span>
              <span className="streak-label">due now</span>
            </div>
          </div>
          <div className="fc-dash-decks">
            {topDecks.map(({ deck, due: d }) => (
              <button className="fc-dash-deck" key={deck.id} onClick={() => open(`#deck=${deck.id}`)}>
                <span className="fc-dash-deck-name">{deck.name}</span>
                <span className="fc-dash-deck-due">{d}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <button className="sprint-start" onClick={() => open(due > 0 && topDecks[0] ? `#review=${topDecks[0].deck.id}` : '')}>
        {due > 0 ? '▶ Study now' : 'Open flashcards'}
      </button>
    </section>
  );
}

function PapersPanel() {
  const { readingNow, toReadCount } = usePapers();
  const openPage = () => void chrome.tabs.create({ url: chrome.runtime.getURL(PAPERS_PAGE_PATH) });
  // Papers read in the PDF reader reopen there, resuming the saved position
  const openPaper = (p: Paper) => {
    const url = paperOpenUrl(p);
    if (url) void chrome.tabs.create({ url });
    else openPage();
  };
  const top = readingNow.slice(0, 4);

  return (
    <section className="panel">
      <h2>📄 Papers</h2>
      {readingNow.length === 0 ? (
        <p className="panel-empty">
          {toReadCount > 0
            ? `${toReadCount} paper${toReadCount === 1 ? '' : 's'} queued to read.`
            : 'No papers yet — track what you read, and pick up where you drifted off.'}
        </p>
      ) : (
        <>
          <p className="row-label">Reading now</p>
          <div className="paper-now-list">
            {top.map((p) => (
              <button
                key={p.id}
                className="paper-now"
                title={p.leftOff ? `Left off: ${p.leftOff}` : p.title}
                onClick={() => openPaper(p)}
              >
                <div className="paper-now-top">
                  <span className="paper-now-title">{p.title}</span>
                  <span className="paper-now-pct">{p.progressPercent}%</span>
                </div>
                <div className="dash-bar">
                  <div className="dash-bar-fill" style={{ width: `${p.progressPercent}%` }} />
                </div>
                {p.leftOff && <span className="paper-now-leftoff">↳ {p.leftOff}</span>}
              </button>
            ))}
          </div>
          {toReadCount > 0 && (
            <p className="paper-toread">
              {toReadCount} more queued to read
            </p>
          )}
        </>
      )}
      <button className="sprint-start" onClick={openPage}>
        {readingNow.length > 0 || toReadCount > 0 ? 'Open Papers' : '+ Track a paper'}
      </button>
    </section>
  );
}

function TaskPanel() {
  const tasks = useTasks();
  const [text, setText] = useState('');
  const [ignitionTaskId, setIgnitionTaskId] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText('');
    await tasks.addTask(trimmed, 'newtab');
  };

  return (
    <section className="panel">
      <h2>📝 Tasks</h2>
      <form
        className="dash-task-add"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a task… (⌘⇧Y works anywhere)"
          maxLength={300}
        />
      </form>
      <div className="panel-scroll">
        {tasks.openTasks.length === 0 ? (
          <p className="panel-empty">Nothing pending. 🎉</p>
        ) : (
          <SortableTaskList
            tasks={tasks.openTasks}
            onMove={(id, toIndex) => void tasks.moveTask(id, toIndex)}
            renderRow={(task, handle) => (
              <>
                <DashTaskRow
                  task={task}
                  tasks={tasks}
                  handle={handle}
                  onIgnite={() =>
                    setIgnitionTaskId((cur) => (cur === task.id ? null : task.id))
                  }
                />
                {ignitionTaskId === task.id && (
                  <IgnitionCard task={task} onClose={() => setIgnitionTaskId(null)} />
                )}
              </>
            )}
          />
        )}
        {tasks.completedTasks.length > 0 && (
          <>
            <p className="row-label">Done</p>
            {tasks.completedTasks.slice(0, 5).map((task) => (
              <DashTaskRow key={task.id} task={task} tasks={tasks} />
            ))}
          </>
        )}
      </div>
    </section>
  );
}

function DashTaskRow({
  task,
  tasks,
  handle,
  onIgnite,
}: {
  task: Task;
  tasks: ReturnType<typeof useTasks>;
  handle?: React.JSX.Element;
  onIgnite?: () => void;
}) {
  const done = task.completedAt !== null;
  const snoozed = task.snoozedUntil !== null && task.snoozedUntil > Date.now();
  return (
    <div className={done ? 'dash-task done' : 'dash-task'}>
      {handle}
      <input type="checkbox" checked={done} onChange={() => void tasks.toggleTask(task.id)} />
      <div className="dash-task-body">
        <span className="dash-task-text">{task.text}</span>
        <span className="dash-task-meta">
          {formatRelativeDate(new Date(task.createdAt))}
          {snoozed && ` · snoozed until ${formatTime(new Date(task.snoozedUntil!))}`}
        </span>
      </div>
      {!done && onIgnite && (
        <button className="task-ignite" title="Stuck? Get a 2-minute first step" onClick={onIgnite}>
          ⚡
        </button>
      )}
      {!done && (
        <button
          className="ghost-btn"
          title="Snooze reminders for 1 hour"
          onClick={() => void sendMessage({ type: 'SNOOZE_TASK', id: task.id, minutes: 60 })}
        >
          💤
        </button>
      )}
      <button className="ghost-btn" title="Delete" onClick={() => void tasks.deleteTask(task.id)}>
        ✕
      </button>
    </div>
  );
}

function ContinuePanel() {
  const [readingProgress] = useStorageValue('readingProgress');

  const inProgress = useMemo(
    () =>
      Object.entries(readingProgress)
        .filter(([, p]) => p.completedAt === null && p.maxPercent >= 5)
        .sort(([, a], [, b]) => b.updatedAt - a.updatedAt),
    [readingProgress],
  );

  return (
    <section className="panel">
      <h2>📖 Continue</h2>
      <div className="panel-scroll">
        {inProgress.length === 0 ? (
          <p className="panel-empty">No half-read articles or videos. Open one from the popup!</p>
        ) : (
          inProgress.map(([key, p]) => (
            <div
              key={key}
              className="dash-article"
              onClick={() =>
                void sendMessage({
                  type: 'OPEN_ARTICLE',
                  url: p.url,
                  feedItemId: p.kind === 'video' ? null : p.feedItemId,
                  resume: true,
                })
              }
            >
              <div className="dash-article-top">
                <span className="dash-article-title">
                  {p.kind === 'video' ? '🎬 ' : ''}
                  {p.title || p.url}
                </span>
                <span className="dash-article-percent">{p.maxPercent}%</span>
              </div>
              <div className="dash-bar">
                <div className="dash-bar-fill" style={{ width: `${p.maxPercent}%` }} />
              </div>
              <span className="dash-article-meta">
                {p.kind === 'video'
                  ? `${formatWatchTime(p.positionSeconds)} / ${formatWatchTime(p.durationSeconds)} · `
                  : ''}
                {p.source ? `${p.source} · ` : ''}
                {formatRelativeDate(new Date(p.updatedAt))}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function StreakPanel() {
  const [streaks] = useStorageValue('streaks');
  const [storedSettings] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };
  const sprint = useSprint();

  const days = useMemo(() => {
    const out: { date: string; label: string; minutes: number; qualified: boolean }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = daysAgo(i);
      const date = localDate(d);
      const stats = streaks.daily[date];
      const minutes = stats?.minutes ?? 0;
      out.push({
        date,
        label: d.toLocaleDateString('en-US', { weekday: 'narrow' }),
        minutes,
        qualified: minutes >= settings.dailyGoalMinutes || (stats?.sprints ?? 0) >= 1,
      });
    }
    return out;
  }, [streaks, settings.dailyGoalMinutes]);

  const today = streaks.daily[localDate()];

  return (
    <section className="panel">
      <h2>🔥 Focus</h2>
      <div className="streak-numbers">
        <div className="streak-stat">
          <span className="streak-value">{streaks.currentStreak}</span>
          <span className="streak-label">day streak</span>
        </div>
        <div className="streak-stat">
          <span className="streak-value">{streaks.longestStreak}</span>
          <span className="streak-label">longest</span>
        </div>
        <div className="streak-stat">
          <span className="streak-value">{Math.round(today?.minutes ?? 0)}</span>
          <span className="streak-label">min today</span>
        </div>
        <div
          className="streak-stat"
          title="Freeze tokens auto-cover missed days so a bad day can't break your streak. Earn one every 5 consecutive days (max 3)."
        >
          <span className="streak-value">🧊{streaks.freezeTokens ?? 0}</span>
          <span className="streak-label">freezes</span>
        </div>
      </div>

      <div className="heatmap" title={`Goal: ${settings.dailyGoalMinutes} min of reading (or one sprint) per day`}>
        {days.map((day) => (
          <div key={day.date} className="heat-col">
            <div
              className={day.qualified ? 'heat-cell qualified' : 'heat-cell'}
              title={`${day.date}: ${Math.round(day.minutes)} min`}
            />
            <span className="heat-label">{day.label}</span>
          </div>
        ))}
      </div>

      {sprint.active ? (
        <div className="sprint-live">
          <span className="sprint-countdown">{sprint.countdown}</span>
          <p className="sprint-hint">Committed reading — stay with it.</p>
          <button className="sprint-cancel" onClick={() => void sprint.cancel()}>
            Cancel sprint
          </button>
        </div>
      ) : (
        <button className="sprint-start" onClick={() => void sprint.start()}>
          ▶ Start a {settings.sprintMinutes}-minute reading sprint
        </button>
      )}

      <FocusModeSection />
    </section>
  );
}

function FocusModeSection() {
  const focus = useFocusSession();
  const [storedSettings] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };
  const [customMinutes, setCustomMinutes] = useState('');

  if (focus.active) {
    const inFocus = focus.phase === 'focus';
    return (
      <div className="focus-mode active">
        <div className="focus-mode-status">
          <span className="focus-mode-phase">{inFocus ? '🎯 Focus' : '☕ Break'}</span>
          <span className="focus-mode-countdown">{focus.countdown}</span>
        </div>
        {focus.session?.mode === 'pomodoro' && (
          <p className="focus-mode-meta">
            {focus.completedBlocks} block{focus.completedBlocks === 1 ? '' : 's'} done ·{' '}
            {focus.session.focusMinutes}:{focus.session.breakMinutes} pomodoro
          </p>
        )}
        {inFocus ? (
          <p className="focus-mode-meta">{settings.focusBlocklist.length} sites blocked</p>
        ) : (
          <p className="focus-mode-meta">Sites are open — back to it soon.</p>
        )}
        <HoldToQuit label="Hold 5s to end early" onConfirm={() => void focus.stop(true)} />
      </div>
    );
  }

  const startOneshot = (minutes: number) =>
    void focus.start({ mode: 'oneshot', focusMinutes: minutes, breakMinutes: 0 });

  return (
    <div className="focus-mode">
      <p className="row-label">Focus mode — block distractions</p>
      <div className="focus-mode-buttons">
        {FOCUS_PRESETS.map((minutes) => (
          <button key={minutes} className="focus-preset" onClick={() => startOneshot(minutes)}>
            {minutes}m
          </button>
        ))}
        <input
          className="focus-custom"
          type="number"
          min={5}
          max={240}
          placeholder="min"
          value={customMinutes}
          onChange={(e) => setCustomMinutes(e.target.value)}
          onKeyDown={(e) => {
            const n = Number(customMinutes);
            if (e.key === 'Enter' && n >= 5) {
              setCustomMinutes('');
              startOneshot(n);
            }
          }}
        />
        <button
          className="focus-preset pomodoro"
          title={`Cycles of ${settings.focusMinutes} min focus / ${settings.focusBreakMinutes} min break until you stop`}
          onClick={() =>
            void focus.start({
              mode: 'pomodoro',
              focusMinutes: settings.focusMinutes,
              breakMinutes: settings.focusBreakMinutes,
            })
          }
        >
          🍅 {settings.focusMinutes}:{settings.focusBreakMinutes}
        </button>
        <button
          className={settings.focusMusicEnabled ? 'focus-preset music on' : 'focus-preset music'}
          title={
            settings.focusMusicEnabled
              ? 'Flowtunes focus music will open when a session starts (click to disable)'
              : 'Open Flowtunes focus music when a session starts (click to enable)'
          }
          onClick={() =>
            void patchSettings({ focusMusicEnabled: !settings.focusMusicEnabled })
          }
        >
          🎵
        </button>
      </div>
    </div>
  );
}
