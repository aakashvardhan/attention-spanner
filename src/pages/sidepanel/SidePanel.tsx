import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AssistantChat } from '../../shared/components/AssistantChat';
import { BrainDump } from '../../shared/components/BrainDump';
import { LiveCopilot } from '../../shared/components/LiveCopilot';
import { NotesHistory } from '../../shared/components/NotesHistory';
import { localDate } from '../../shared/format';
import { useActiveTab } from '../../shared/hooks/useActiveTab';
import { useFocusSession } from '../../shared/hooks/useFocusSession';
import { useSessionValue } from '../../shared/hooks/useSessionValue';
import { useSprint } from '../../shared/hooks/useSprint';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { useTasks } from '../../shared/hooks/useTasks';
import { useTheme } from '../../shared/hooks/useTheme';
import { isLiveActive } from '../../shared/live';
import { sendMessage } from '../../shared/messages';
import { dueCounts, newIntroducedToday, totalDue } from '../../shared/srs';
import { DEFAULT_SETTINGS } from '../../shared/storage';
import { BookmarkPicker } from './components/BookmarkPicker';
import { CardsPane } from './components/CardsPane';
import { RecordBar } from './components/RecordBar';
import { TaskPane } from './components/TaskPane';

type PrimaryTab = 'ask' | 'tasks' | 'notes';
type View = PrimaryTab | 'cards' | 'live';

function pageContext(tab: chrome.tabs.Tab | null): { title: string; detail: string } {
  if (!tab) return { title: 'Current page', detail: 'Waiting for the active tab' };
  const title = tab.title?.trim() || 'Untitled page';
  try {
    const url = new URL(tab.url ?? '');
    return {
      title,
      detail: url.protocol === 'chrome-extension:' ? 'Reader' : url.hostname.replace(/^www\./, ''),
    };
  } catch {
    return { title, detail: 'Current tab' };
  }
}

export function SidePanel() {
  useTheme();
  const activeTab = useActiveTab();
  const context = pageContext(activeTab);
  const [live] = useSessionValue('liveSession');
  const [activeRecording] = useSessionValue('activeRecording');
  const [view, setView] = useState<View>('ask');
  const [pickingBookmark, setPickingBookmark] = useState(false);
  const [showRecordingTools, setShowRecordingTools] = useState(false);
  const actionsRef = useRef<HTMLDetailsElement>(null);

  const tasks = useTasks();
  const focus = useFocusSession();
  const sprint = useSprint();
  const [gym] = useStorageValue('gym');
  const [storedSettings] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };
  const [flashCards] = useStorageValue('flashCards');
  const [srsDaily] = useStorageValue('srsDaily');
  const cardsDue = totalDue(
    dueCounts(flashCards, Date.now(), newIntroducedToday(srsDaily, localDate())),
  );
  const liveOn = isLiveActive(live);
  const gymDone = localDate() in gym.checkins;

  const primaryTabs: { id: PrimaryTab; label: string; badge: number }[] = [
    { id: 'ask', label: 'Ask', badge: 0 },
    { id: 'tasks', label: 'Tasks', badge: tasks.openTasks.length },
    { id: 'notes', label: 'Notes', badge: 0 },
  ];

  useEffect(() => {
    if (!liveOn) setView((current) => (current === 'live' ? 'ask' : current));
  }, [liveOn]);

  const closeActions = () => {
    actionsRef.current?.removeAttribute('open');
    setPickingBookmark(false);
    setShowRecordingTools(false);
  };

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) closeActions();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeActions();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  });

  useEffect(() => {
    if (activeRecording) closeActions();
  }, [activeRecording]);

  const selectPrimary = (tab: PrimaryTab) => {
    setView(tab);
    closeActions();
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const current = primaryTabs.findIndex((tab) => tab.id === view);
    const from = current < 0 ? 0 : current;
    const next = primaryTabs[(from + step + primaryTabs.length) % primaryTabs.length];
    selectPrimary(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  return (
    <div className="container">
      <div className="panel-chrome">
        <header className="context-header">
          <div className="context-copy">
            <h1 title={context.title}>{context.title}</h1>
            <p>{context.detail}</p>
          </div>

          <details className="panel-actions-menu" ref={actionsRef}>
            <summary>Actions</summary>
            <div className="panel-actions-popover">
              <button
                type="button"
                onClick={() => {
                  setPickingBookmark((current) => !current);
                  setShowRecordingTools(false);
                }}
              >
                Bookmark this page
              </button>
              {!focus.active && (
                <button
                  type="button"
                  onClick={() => {
                    void focus.start({
                      mode: 'oneshot',
                      focusMinutes: settings.focusMinutes,
                      breakMinutes: 0,
                    });
                    closeActions();
                  }}
                >
                  Start {settings.focusMinutes}-minute focus
                </button>
              )}
              {!sprint.active && (
                <button
                  type="button"
                  onClick={() => {
                    void sprint.start();
                    closeActions();
                  }}
                >
                  Start {settings.sprintMinutes}-minute sprint
                </button>
              )}
              {!gymDone && (
                <button
                  type="button"
                  onClick={() => {
                    void sendMessage({ type: 'GYM_CHECKIN' });
                    closeActions();
                  }}
                >
                  Log gym visit
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setView('cards');
                  closeActions();
                }}
              >
                Review cards{cardsDue > 0 ? ` · ${cardsDue} due` : ''}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowRecordingTools((current) => !current);
                  setPickingBookmark(false);
                }}
              >
                Record and transcribe
              </button>
              <button
                type="button"
                onClick={() => {
                  void chrome.runtime.openOptionsPage();
                  closeActions();
                }}
              >
                Settings
              </button>

              {pickingBookmark && <BookmarkPicker onDone={closeActions} />}
              {showRecordingTools && <RecordBar />}
            </div>
          </details>
        </header>

        <nav
          className="tab-bar"
          role="tablist"
          aria-label="Panel sections"
          onKeyDown={onTabKeyDown}
        >
          {primaryTabs.map(({ id, label, badge }) => (
            <button
              key={id}
              id={`tab-${id}`}
              type="button"
              role="tab"
              aria-selected={view === id}
              aria-controls={`panel-${id}`}
              tabIndex={view === id ? 0 : -1}
              className={view === id ? 'tab active' : 'tab'}
              onClick={() => selectPrimary(id)}
            >
              {label}
              {badge > 0 && <span className="tab-count">{badge}</span>}
            </button>
          ))}
        </nav>

        {focus.active && (
          <div className="active-status-row">
            <span>
              <strong>{focus.phase === 'focus' ? 'Focus' : 'Break'}</strong>
              <small>{focus.countdown}</small>
            </span>
            <button type="button" onClick={() => void focus.stop(true)}>
              Stop
            </button>
          </div>
        )}
        {sprint.active && (
          <div className="active-status-row">
            <span>
              <strong>Reading sprint</strong>
              <small>{sprint.countdown}</small>
            </span>
            <button type="button" onClick={() => void sprint.cancel()}>
              Stop
            </button>
          </div>
        )}
        <RecordBar activeOnly onOpenLive={() => setView('live')} />
      </div>

      {view === 'ask' && (
        <main className="ask-main" id="panel-ask" role="tabpanel" aria-labelledby="tab-ask">
          <AssistantChat compact autoFocus surface="sidepanel" />
        </main>
      )}
      {view === 'tasks' && (
        <TaskPane tasks={tasks} id="panel-tasks" labelledBy="tab-tasks" />
      )}
      {view === 'notes' && (
        <main id="panel-notes" role="tabpanel" aria-labelledby="tab-notes">
          <BrainDump source="popup" compact />
          <NotesHistory limit={5} />
        </main>
      )}
      {view === 'cards' && (
        <>
          <div className="secondary-pane-head" id="tab-cards">
            <button type="button" onClick={() => setView('ask')}>
              ‹ Back
            </button>
            <div>
              <h2>Review cards</h2>
              {cardsDue > 0 && <p>{cardsDue} due</p>}
            </div>
          </div>
          <CardsPane id="panel-cards" labelledBy="tab-cards" />
        </>
      )}
      {view === 'live' && (
        <>
          <div className="secondary-pane-head" id="tab-live">
            <button type="button" onClick={() => setView('ask')}>
              ‹ Back
            </button>
            <div>
              <h2>Live assistant</h2>
              <p>Recording in progress</p>
            </div>
          </div>
          <main id="panel-live" role="tabpanel" aria-labelledby="tab-live">
            <LiveCopilot />
          </main>
        </>
      )}
    </div>
  );
}
