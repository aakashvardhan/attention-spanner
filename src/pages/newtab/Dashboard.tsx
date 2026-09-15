import { useEffect, useMemo, useState } from 'react';
import { suggestFirstAction } from '../../shared/ai/ignition';
import {
  mostRecentUnfinished,
  resumableItems,
  resumeContextFromProgress,
} from '../../shared/attention';
import { currentEvent, formatCountdown, nextUpcoming } from '../../shared/calendar';
import {
  JOBS_PAGE_PATH,
  PAPERS_PAGE_PATH,
} from '../../shared/constants';
import { formatTime, formatWatchTime } from '../../shared/format';
import { useFocusSession } from '../../shared/hooks/useFocusSession';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { useTasks } from '../../shared/hooks/useTasks';
import { useTheme } from '../../shared/hooks/useTheme';
import { sendMessage } from '../../shared/messages';
import { paperOpenUrl } from '../../shared/pdf';
import { DEFAULT_SETTINGS, getLocal, setLocal } from '../../shared/storage';
import type {
  Job,
  ActiveIntent,
  EnabledPack,
  IntentResumeContext,
  Paper,
  Task,
} from '../../shared/types';
import { FREEZE_TOKEN_CAP } from '../../shared/streakInsurance';
import { isWatchingNow, livePositionSeconds } from '../../shared/youtube';
import { ActivityCalendar } from './ActivityCalendar';
import { AssistantDock } from './AssistantDock';
import { BookmarksPanel } from './BookmarksPanel';

export function Dashboard() {
  // initTheme() in main.tsx only resolves the theme once, at load. Without this
  // a skin or theme changed in Options never reaches an already-open new tab —
  // every other page in the extension subscribes.
  useTheme();
  const [activeIntent] = useStorageValue('activeIntent');
  const [readingProgress] = useStorageValue('readingProgress');
  const [streaks] = useStorageValue('streaks');
  const [papers] = useStorageValue('papers');
  const [calendar] = useStorageValue('calendar');
  const [gmail] = useStorageValue('gmail');
  const [enabledPacks] = useStorageValue('enabledPacks');
  const [notes] = useStorageValue('notes');
  const [jobs] = useStorageValue('jobs');
  const [storedSettings] = useStorageValue('settings');
  const tasks = useTasks();
  const focus = useFocusSession();
  const [manualText, setManualText] = useState('');
  const [breadcrumb, setBreadcrumb] = useState('');
  const [smallerAction, setSmallerAction] = useState('');
  const [thinking, setThinking] = useState(false);
  const [acknowledgment, setAcknowledgment] = useState('');
  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };

  const recentProgress = useMemo(
    () => mostRecentUnfinished(readingProgress),
    [readingProgress],
  );
  const recentPaper = useMemo(
    () =>
      papers
        .filter((paper) => paper.status === 'reading' && paper.lastReadAt !== null)
        .sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0))[0] ?? null,
    [papers],
  );
  const resumable = useMemo(
    () => resumableItems(readingProgress, papers),
    [readingProgress, papers],
  );
  const candidate = useMemo(
    () => activeIntent ?? candidateIntent(tasks.openTasks[0] ?? null, recentProgress, recentPaper),
    [activeIntent, tasks.openTasks, recentProgress, recentPaper],
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

  const now = new Date();
  const happening = currentEvent(calendar.events, now);
  const upcoming = nextUpcoming(calendar.events, now);
  const relevantEvent =
    happening ?? (upcoming && upcoming.minutesUntil <= 120 ? upcoming.event : null);

  useEffect(() => {
    setBreadcrumb(candidate?.resumeContext?.breadcrumb ?? '');
  }, [candidate?.id, candidate?.resumeContext?.breadcrumb]);

  const chooseManual = async () => {
    const text = manualText.trim();
    if (!text) return;
    const next: ActiveIntent = {
      id: crypto.randomUUID(),
      text,
      source: 'manual',
      sourceId: null,
      fromTodayBrainDump: false,
      createdAt: Date.now(),
      startedAt: null,
      state: 'ready',
      resumeContext: null,
    };
    setManualText('');
    await setLocal({ activeIntent: next });
  };

  const ensureStored = async (): Promise<ActiveIntent | null> => {
    if (!candidate) return null;
    const stored: ActiveIntent = {
      ...candidate,
      state: 'active',
      startedAt: candidate.startedAt ?? Date.now(),
      resumeContext: candidate.resumeContext
        ? { ...candidate.resumeContext, breadcrumb: breadcrumb.trim() }
        : null,
    };
    await setLocal({ activeIntent: stored });
    return stored;
  };

  const start = async () => {
    const intent = await ensureStored();
    if (!intent) return;
    if (focus.active) {
      if (intent.resumeContext) await openResume(intent.resumeContext);
      return;
    }
    await sendMessage({
      type: 'START_FOCUS',
      mode: 'oneshot',
      focusMinutes: intent.state === 'blocked' || smallerAction ? 5 : settings.focusMinutes,
      breakMinutes: settings.focusBreakMinutes,
      ...(intent.source === 'task' && intent.sourceId ? { taskId: intent.sourceId } : {}),
      intent: smallerAction || intent.text,
    });
    if (intent.resumeContext) {
      await openResume(intent.resumeContext);
    }
  };

  const closeLoop = async (result: 'done' | 'later' | 'blocked') => {
    if (!candidate) return;
    if (focus.active) await focus.stop(true);
    if (result === 'done') {
      if (candidate.source === 'task' && candidate.sourceId) {
        const linked = tasks.openTasks.find((task) => task.id === candidate.sourceId);
        if (linked) await tasks.toggleTask(linked.id);
      }
      await sendMessage({ type: 'JOURNAL_APPEND', kind: 'action', text: `Done: ${candidate.text}` });
      await setLocal({ activeIntent: null });
      setAcknowledgment('Finished. That loop is closed.');
      return;
    }
    if (result === 'later') {
      await setLocal({
        activeIntent: {
          ...candidate,
          state: 'paused',
          resumeContext: candidate.resumeContext
            ? { ...candidate.resumeContext, breadcrumb: breadcrumb.trim() }
            : null,
        },
      });
      return;
    }
    setThinking(true);
    try {
      setSmallerAction(await suggestFirstAction(candidate.text));
    } catch {
      setSmallerAction(`Open what you need and work on “${candidate.text}” for two minutes.`);
    } finally {
      setThinking(false);
    }
    await setLocal({ activeIntent: { ...candidate, state: 'blocked' } });
  };

  const actionableMail = enabledPacks.includes('work')
    ? gmail.triaged.filter((message) => message.bucket === 'URGENT' || message.bucket === 'THIS_WEEK')
    : [];
  const laterItems = [
    ...tasks.openTasks
      .filter((task) => !(candidate?.source === 'task' && candidate.sourceId === task.id))
      .map((task) => ({ id: `task:${task.id}`, label: task.text, task })),
    ...(recentProgress && candidate?.source !== 'resume'
      ? [{ id: 'resume', label: recentProgress.title || recentProgress.url, progress: recentProgress }]
      : []),
    ...(recentPaper && candidate?.resumeContext?.kind !== 'pdf'
      ? [{ id: `paper:${recentPaper.id}`, label: recentPaper.title, paper: recentPaper }]
      : []),
    ...actionableMail.map((mail) => ({
      id: `mail:${mail.accountId}:${mail.id}`,
      label: mail.subject || mail.from,
      mail,
    })),
  ].slice(0, 3);

  const setLaterAsNow = async (item: (typeof laterItems)[number]) => {
    if ('task' in item && item.task) {
      await setLocal({ activeIntent: intentFromTask(item.task) });
    } else if ('progress' in item && item.progress) {
      await setLocal({ activeIntent: intentFromProgress(item.progress) });
    } else if ('paper' in item && item.paper) {
      await setLocal({ activeIntent: intentFromPaper(item.paper) });
    } else if ('mail' in item && item.mail) {
      const accountIndex = Math.max(
        0,
        gmail.accounts.findIndex((account) => account.id === item.mail!.accountId),
      );
      await setLocal({
        activeIntent: {
          id: `mail:${item.mail.accountId}:${item.mail.id}`,
          text: item.mail.subject || `Reply to ${item.mail.from}`,
          source: 'manual',
          sourceId: item.mail.id,
          fromTodayBrainDump: false,
          createdAt: item.mail.receivedAt,
          startedAt: null,
          state: 'ready',
          resumeContext: {
            kind: 'web',
            url: `https://mail.google.com/mail/u/${accountIndex}/#inbox/${item.mail.id}`,
            title: item.mail.subject,
            breadcrumb: '',
          },
        },
      });
    }
  };

  return (
    <>
      <main className="relay">
        <header className="relay-header">
          <div>
            <p className="relay-eyebrow"><span aria-hidden="true" /> Focus workspace</p>
            <h1>What’s next?</h1>
          </div>
          <div className="relay-header-right">
            {/* The only place the streak is visible. It is the reason to come
                back tomorrow, so it sits in the header rather than behind a
                disclosure — but as one quiet line, not a scoreboard. */}
            {streaks.currentStreak > 0 && (
              <p className="relay-streak">
                <strong>{streaks.currentStreak}</strong>{' '}
                <span>day{streaks.currentStreak === 1 ? '' : 's'}</span>
                {(streaks.freezeTokens ?? 0) > 0 && (
                  <span className="relay-freezes">
                    {' · '}
                    {streaks.freezeTokens}/{FREEZE_TOKEN_CAP} freeze
                    {streaks.freezeTokens === 1 ? '' : 's'}
                  </span>
                )}
              </p>
            )}
            <button className="relay-command" onClick={() => void openSidePanel()}>
              Open workspace
            </button>
          </div>
        </header>
        {acknowledgment && <p className="relay-ack" role="status">{acknowledgment}</p>}

      <section className="relay-now" aria-labelledby="relay-now-title">
        <div className="relay-now-label">
          <span>Now</span>
          {candidate?.fromTodayBrainDump && <small>from today’s reset</small>}
        </div>
        {candidate ? (
          <>
            <h2 id="relay-now-title">{candidate.text}</h2>
            {candidate.resumeContext && (
              <label className="relay-breadcrumb">
                <span>Next step when you return</span>
                <input
                  value={breadcrumb}
                  onChange={(event) => setBreadcrumb(event.target.value)}
                  placeholder="e.g. Compare Figure 3 with the baseline"
                  maxLength={240}
                />
              </label>
            )}
            {smallerAction && <p className="relay-smaller">Start smaller: {smallerAction}</p>}
            <button className="relay-start" onClick={() => void start()}>
              {candidate.resumeContext ? 'Resume' : focus.active ? `Session · ${focus.countdown}` : 'Start'}
            </button>
            {(candidate.startedAt !== null || focus.active || candidate.state === 'blocked') && (
              <div className="relay-close-loop" aria-label="Close this attention loop">
                <button onClick={() => void closeLoop('done')}>Done</button>
                <button onClick={() => void closeLoop('later')}>Continue later</button>
                <button disabled={thinking} onClick={() => void closeLoop('blocked')}>
                  {thinking ? 'Finding a smaller step…' : 'Blocked'}
                </button>
              </div>
            )}
          </>
        ) : (
          <form
            className="relay-manual"
            onSubmit={(event) => {
              event.preventDefault();
              void chooseManual();
            }}
          >
            <label htmlFor="manual-intent">Choose one thing that matters now.</label>
            <div>
              <input
                id="manual-intent"
                value={manualText}
                onChange={(event) => setManualText(event.target.value)}
                placeholder="Write the first draft"
                maxLength={300}
              />
              <button disabled={!manualText.trim()}>Set Now</button>
            </div>
          </form>
        )}

        {relevantEvent && (
          <a
            className="relay-event"
            href={relevantEvent.hangoutLink || relevantEvent.htmlLink || undefined}
            target="_blank"
            rel="noreferrer"
          >
            <span>{happening ? 'Happening now' : formatCountdown(upcoming!.minutesUntil)}</span>
            <strong>{relevantEvent.title}</strong>
            <small>{formatTime(new Date(relevantEvent.startMs))}</small>
          </a>
        )}
      </section>

      {resumable.length > 0 && (
        <section className="relay-continue" aria-labelledby="continue-title">
          <h2 id="continue-title">Continue reading</h2>
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
                  {/* A video playing in another tab is context, not the
                      decision this screen exists to make — so it marks the row
                      it already occupies rather than earning a card that would
                      compete with Now. */}
                  {item.progress && isWatchingNow(item.progress, watchingNow) && (
                    <small className="relay-watching">
                      Watching · {formatWatchTime(livePositionSeconds(item.progress, watchingNow))}
                    </small>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {laterItems.length > 0 && (
        <details className="relay-later">
          <summary>Later <span>{laterItems.length}</span></summary>
          <div>
            {laterItems.map((item) => (
              <button key={item.id} onClick={() => void setLaterAsNow(item)}>
                <span>{item.label}</span>
                <small>Make Now</small>
              </button>
            ))}
          </div>
        </details>
      )}

        <JobsStrip jobs={jobs} />

        <BookmarksPanel />

        {/* A 53-week grid is heavy against a one-decision screen, so it opens
            on demand. The header streak is the at-a-glance version. */}
        <details className="relay-history">
          <summary>Activity</summary>
          <ActivityCalendar />
        </details>

        <Library enabledPacks={enabledPacks} notes={notes} />
      </main>
      <AssistantDock />
    </>
  );
}

function candidateIntent(
  task: Task | null,
  progress: ReturnType<typeof mostRecentUnfinished>,
  paper: Paper | null,
) {
  if (task) return intentFromTask(task);
  if (progress) return intentFromProgress(progress);
  if (paper) return intentFromPaper(paper);
  return null;
}

function intentFromTask(task: Task): ActiveIntent {
  return {
    id: `task:${task.id}`,
    text: task.text,
    source: 'task',
    sourceId: task.id,
    fromTodayBrainDump:
      task.source === 'braindump' &&
      new Date(task.createdAt).toDateString() === new Date().toDateString(),
    createdAt: task.createdAt,
    startedAt: null,
    state: 'ready',
    resumeContext: null,
  };
}

function intentFromProgress(progress: NonNullable<ReturnType<typeof mostRecentUnfinished>>): ActiveIntent {
  return {
    id: `resume:${progress.url}`,
    text: progress.title || 'Continue where you left off',
    source: 'resume',
    sourceId: null,
    fromTodayBrainDump: false,
    createdAt: progress.updatedAt,
    startedAt: null,
    state: 'paused',
    resumeContext: resumeContextFromProgress(progress),
  };
}

function intentFromPaper(paper: Paper): ActiveIntent {
  return {
    id: `paper:${paper.id}`,
    text: paper.title,
    source: 'resume',
    sourceId: paper.id,
    fromTodayBrainDump: false,
    createdAt: paper.lastReadAt ?? paper.addedAt,
    startedAt: null,
    state: 'paused',
    resumeContext: {
      kind: 'pdf',
      url: paperOpenUrl(paper),
      title: paper.title,
      page: paper.pdf?.page,
      offset: paper.pdf?.offset,
      breadcrumb: paper.leftOff,
    },
  };
}

async function openResume(context: IntentResumeContext) {
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

/**
 * Jobs on the relay. Shown only once the board has something in it — an empty
 * strip on a one-decision screen is noise, and Settings is where you go to set
 * a source up in the first place.
 *
 * It leads with what deserves attention (unreviewed, unblocked, scoring well)
 * and falls back to the plain count, so the number on screen is always one you
 * could act on rather than a total that only ever grows.
 */
function JobsStrip({ jobs }: { jobs: Job[] }) {
  const strong = jobs.filter(
    (job) => job.status === 'new' && (job.score?.blockers.length ?? 0) === 0 && (job.score?.total ?? 0) >= 60,
  ).length;
  const shortlisted = jobs.filter((job) => job.status === 'shortlist').length;
  if (jobs.length === 0) return null;

  return (
    <section className="relay-jobs">
      <div>
        <h2>Jobs</h2>
        <p>
          {strong > 0
            ? `${strong} new match${strong === 1 ? '' : 'es'} worth a look`
            : `${jobs.length} tracked, nothing new above the bar`}
          {shortlisted > 0 && ` · ${shortlisted} shortlisted`}
        </p>
      </div>
      <button onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL(JOBS_PAGE_PATH) })}>
        Open board
      </button>
    </section>
  );
}

function Library({
  enabledPacks,
  notes,
}: {
  enabledPacks: EnabledPack[];
  notes: { id: string; rawText: string; createdAt: number; encRaw?: string }[];
}) {
  const togglePack = async (pack: EnabledPack) => {
    const { enabledPacks: latest } = await getLocal('enabledPacks');
    await setLocal({
      enabledPacks: latest.includes(pack)
        ? latest.filter((item) => item !== pack)
        : [...latest, pack],
    });
  };
  const openPage = (path: string) => chrome.tabs.create({ url: chrome.runtime.getURL(path) });

  return (
    <details className="relay-library">
      <summary>Library and optional tools</summary>
      <div className="relay-library-body">
        <section>
          <h2>Daily resets</h2>
          {notes.length === 0 ? (
            <p>No saved resets yet.</p>
          ) : (
            <ul>
              {notes.slice(0, 3).map((note) => (
                <li key={note.id}>
                  <time>{new Date(note.createdAt).toLocaleDateString()}</time>
                  <span>{note.encRaw ? 'Encrypted brain dump' : note.rawText.slice(0, 100)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h2>Packs</h2>
          <div className="relay-packs">
            {(['research', 'work', 'assistant'] as const).map((pack) => (
              <button
                key={pack}
                aria-pressed={enabledPacks.includes(pack)}
                onClick={() => void togglePack(pack)}
              >
                {pack} <span>{enabledPacks.includes(pack) ? 'On' : 'Off'}</span>
              </button>
            ))}
          </div>
          {enabledPacks.includes('research') && (
            <div className="relay-tool-links">
              <button onClick={() => void openPage(PAPERS_PAGE_PATH)}>Papers</button>
            </div>
          )}
          {enabledPacks.includes('work') && (
            <div className="relay-tool-links">
              <button onClick={() => void openPage(JOBS_PAGE_PATH)}>Jobs</button>
            </div>
          )}
          {enabledPacks.includes('work') && <p>Calendar timing and actionable mail are enabled.</p>}
          {enabledPacks.includes('assistant') && (
            <button className="relay-inline-link" onClick={() => void openSidePanel()}>
              Open command box
            </button>
          )}
        </section>
      </div>
    </details>
  );
}
