import { useState } from 'react';
import { BrainDump } from '../../shared/components/BrainDump';
import { NotesHistory } from '../../shared/components/NotesHistory';
import { useFeed } from '../../shared/hooks/useFeed';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { useTasks } from '../../shared/hooks/useTasks';
import { useTheme } from '../../shared/hooks/useTheme';
import { formatTime, localDate } from '../../shared/format';
import { dueCounts, newIntroducedToday, totalDue } from '../../shared/srs';
import { CardsPane } from './components/CardsPane';
import { FeedPane } from './components/FeedPane';
import { FocusBar } from './components/FocusBar';
import { TaskPane } from './components/TaskPane';

type Tab = 'feeds' | 'tasks' | 'dump' | 'cards';

export function Popup() {
  useTheme();
  const [tab, setTab] = useState<Tab>('feeds');
  const feed = useFeed();
  const tasks = useTasks();
  const [flashCards] = useStorageValue('flashCards');
  const [srsDaily] = useStorageValue('srsDaily');
  const cardsDue = totalDue(
    dueCounts(flashCards, Date.now(), newIntroducedToday(srsDaily, localDate())),
  );

  return (
    <div className="container">
      <header>
        <h1>📖 Reader</h1>
        <div className="header-actions">
          {tab === 'feeds' && (
            <button
              className="icon-btn"
              title="Refresh feeds"
              onClick={() => void feed.refresh()}
              disabled={feed.refreshing}
            >
              ↻
            </button>
          )}
          <button
            className="icon-btn"
            title="Settings"
            onClick={() => chrome.runtime.openOptionsPage()}
          >
            ⚙️
          </button>
        </div>
      </header>

      <nav className="tab-bar">
        <button className={tab === 'feeds' ? 'tab active' : 'tab'} onClick={() => setTab('feeds')}>
          Feeds{feed.unreadCount > 0 && <span className="tab-count">{feed.unreadCount}</span>}
        </button>
        <button className={tab === 'tasks' ? 'tab active' : 'tab'} onClick={() => setTab('tasks')}>
          Tasks
          {tasks.openTasks.length > 0 && <span className="tab-count">{tasks.openTasks.length}</span>}
        </button>
        <button className={tab === 'dump' ? 'tab active' : 'tab'} onClick={() => setTab('dump')}>
          🧠 Dump
        </button>
        <button className={tab === 'cards' ? 'tab active' : 'tab'} onClick={() => setTab('cards')}>
          🃏 Cards
          {cardsDue > 0 && <span className="tab-count">{cardsDue}</span>}
        </button>
      </nav>

      <FocusBar />

      {tab === 'feeds' && <FeedPane feed={feed} />}
      {tab === 'tasks' && <TaskPane tasks={tasks} />}
      {tab === 'dump' && (
        <main>
          <BrainDump source="popup" compact />
          <NotesHistory limit={5} />
        </main>
      )}
      {tab === 'cards' && <CardsPane />}

      <footer>
        {tab === 'feeds' && feed.cacheTimestamp > 0
          ? `Last updated: ${formatTime(new Date(feed.cacheTimestamp))}`
          : ' '}
      </footer>
    </div>
  );
}
