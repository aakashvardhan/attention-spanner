import { useState } from 'react';
import { IgnitionCard } from '../../../shared/components/IgnitionCard';
import { SortableTaskList } from '../../../shared/components/SortableTaskList';
import { formatRelativeDate } from '../../../shared/format';
import type { useTasks } from '../../../shared/hooks/useTasks';
import type { Task } from '../../../shared/types';

export function TaskPane({ tasks }: { tasks: ReturnType<typeof useTasks> }) {
  const [text, setText] = useState('');
  const [ignitionTaskId, setIgnitionTaskId] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText('');
    await tasks.addTask(trimmed, 'popup');
  };

  return (
    <main>
      <form
        className="task-add"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a task… (or press ⌘⇧Y anywhere)"
          maxLength={300}
        />
        <button type="submit" disabled={!text.trim()}>
          Add
        </button>
      </form>

      {tasks.openTasks.length === 0 && tasks.completedTasks.length === 0 ? (
        <div className="center-state">
          <p>No tasks yet. Nothing forgotten so far. 🎉</p>
        </div>
      ) : (
        <div className="task-list">
          <SortableTaskList
            tasks={tasks.openTasks}
            onMove={(id, toIndex) => void tasks.moveTask(id, toIndex)}
            renderRow={(task, handle) => (
              <>
                <TaskRow
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
          {tasks.completedTasks.length > 0 && (
            <>
              <p className="task-section-label">Done</p>
              {tasks.completedTasks.map((task) => (
                <TaskRow key={task.id} task={task} tasks={tasks} />
              ))}
            </>
          )}
        </div>
      )}
    </main>
  );
}

function TaskRow({
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
  return (
    <div className={done ? 'task-row done' : 'task-row'}>
      {handle}
      <input
        type="checkbox"
        checked={done}
        onChange={() => void tasks.toggleTask(task.id)}
        title={done ? 'Mark as open' : 'Mark as done'}
      />
      <div className="task-body">
        <span className="task-text">{task.text}</span>
        <span className="task-date">{formatRelativeDate(new Date(task.createdAt))}</span>
      </div>
      {!done && onIgnite && (
        <button className="task-ignite" title="Stuck? Get a 2-minute first step" onClick={onIgnite}>
          ⚡
        </button>
      )}
      <button
        className="task-delete"
        title="Delete task"
        onClick={() => void tasks.deleteTask(task.id)}
      >
        ✕
      </button>
    </div>
  );
}
