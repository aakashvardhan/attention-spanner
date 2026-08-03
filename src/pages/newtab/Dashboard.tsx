import { useEffect, useMemo, useState } from 'react';
import { suggestFirstAction } from '../../shared/ai/ignition';
import {
  mostRecentUnfinished,
  resumeContextFromProgress,
} from '../../shared/attention';
import { currentEvent, formatCountdown, nextUpcoming } from '../../shared/calendar';
import { DailyBrainDumpGate } from '../../shared/components/DailyBrainDumpGate';
import {
  PAPERS_PAGE_PATH,
} from '../../shared/constants';
import { isDailyBrainDumpComplete } from '../../shared/dailyBrainDump';
import { formatTime } from '../../shared/format';
import { useFocusSession } from '../../shared/hooks/useFocusSession';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { useTasks } from '../../shared/hooks/useTasks';
import { sendMessage } from '../../shared/messages';
import { paperOpenUrl } from '../../shared/pdf';
import { DEFAULT_SETTINGS, getLocal, setLocal } from '../../shared/storage';
import type {
  ActiveIntent,
  EnabledPack,
  IntentResumeContext,
  ParkingLotItem,
  Paper,
  Task,
} from '../../shared/types';
import { AssistantDock } from './AssistantDock';
import { BookmarksPanel } from './BookmarksPanel';
import { XBookmarksPanel } from './XBookmarksPanel';

export function Dashboard() {
  const [gate, loaded] = useStorageValue('dailyBrainDumpGate');
  const complete = isDailyBrainDumpComplete(gate);
  const [gateFlowActive, setGateFlowActive] = useState(false);

  useEffect(() => {
    if (loaded && !complete) setGateFlowActive(true);
  }, [loaded, complete]);

  if (!loaded) {
    return (
      <main className="daily-gate daily-gate--center" aria-busy="true">
        <div className="daily-gate-spinner" />
        <p>Preparing today’s workspace…</p>
      </main>
    );
  }
  if (!complete || gateFlowActive) {
    return <DailyBrainDumpGate onContinue={() => setGateFlowActive(false)} />;
  }
  return <AttentionRelay />;
}

function AttentionRelay() {
  const [activeIntent] = useStorageValue('activeIntent');
  const [readingProgress] = useStorageValue('readingProgress');
  const [papers] = useStorageValue('papers');
  const [calendar] = useStorageValue('calendar');
  const [gmail] = useStorageValue('gmail');
  const [parkingLot] = useStorageValue('parkingLot');
  const [enabledPacks] = useStorageValue('enabledPacks');
  const [notes] = useStorageValue('notes');
  const [storedSettings] = useStorageValue('settings');
  const tasks = useTasks();
  const focus = useFocusSession();
  const [manualText, setManualText] = useState('');
  const [parkText, setParkText] = useState('');
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
  const candidate = useMemo(
    () => activeIntent ?? candidateIntent(tasks.openTasks[0] ?? null, recentProgress, recentPaper),
    [activeIntent, tasks.openTasks, recentProgress, recentPaper],
  );
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

  const park = async () => {
    const text = parkText.trim();
    if (!text) return;
    const item: ParkingLotItem = { id: crypto.randomUUID(), text, createdAt: Date.now() };
    const { parkingLot: latest } = await getLocal('parkingLot');
    setParkText('');
    await setLocal({ parkingLot: [item, ...latest].slice(0, 100) });
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
          <button className="relay-command" onClick={() => void openSidePanel()}>
            Open workspace
          </button>
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

      <section className="relay-parking" aria-labelledby="parking-title">
        <div>
          <h2 id="parking-title">Parking Lot</h2>
          <p>Capture it without committing to it.</p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void park();
          }}
        >
          <input
            value={parkText}
            onChange={(event) => setParkText(event.target.value)}
            placeholder="A thought for later…"
            maxLength={500}
          />
          <button disabled={!parkText.trim()}>Park</button>
        </form>
        {parkingLot.length > 0 && (
          <details>
            <summary>{parkingLot.length} parked thought{parkingLot.length === 1 ? '' : 's'}</summary>
            <ul>{parkingLot.slice(0, 5).map((item) => <li key={item.id}>{item.text}</li>)}</ul>
          </details>
        )}
      </section>

        <BookmarksPanel />
        <XBookmarksPanel />
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
