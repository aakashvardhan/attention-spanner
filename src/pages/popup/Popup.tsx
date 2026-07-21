import { useState } from 'react';
import { AssistantChat } from '../../shared/components/AssistantChat';
import { BrainDump } from '../../shared/components/BrainDump';
import { NotesHistory } from '../../shared/components/NotesHistory';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { useTasks } from '../../shared/hooks/useTasks';
import { useTheme } from '../../shared/hooks/useTheme';
import { localDate } from '../../shared/format';
import { dueCounts, newIntroducedToday, totalDue } from '../../shared/srs';
import { CardsPane } from './components/CardsPane';
import { FocusBar } from './components/FocusBar';
import { TaskPane } from './components/TaskPane';

type Tab = 'tasks' | 'dump' | 'cards' | 'ask';

export function Popup() {
  useTheme();
  const [tab, setTab] = useState<Tab>('ask');
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
        <button className={tab === 'ask' ? 'tab active' : 'tab'} onClick={() => setTab('ask')}>
          🤖 Ask
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

      {tab === 'ask' && (
        <main>
          <AssistantChat compact />
        </main>
      )}
      {tab === 'tasks' && <TaskPane tasks={tasks} />}
      {tab === 'dump' && (
        <main>
          <BrainDump source="popup" compact />
          <NotesHistory limit={5} />
        </main>
      )}
      {tab === 'cards' && <CardsPane />}
    </div>
  );
}
