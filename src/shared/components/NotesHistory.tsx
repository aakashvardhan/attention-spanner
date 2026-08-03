import { useState } from 'react';
import { formatRelativeDate } from '../format';
import { useBrainDumpAI } from '../hooks/useBrainDumpAI';
import { useNotes } from '../hooks/useNotes';
import { useNotesLock } from '../hooks/useNotesLock';
import type { BrainDumpNote } from '../types';
import './brainDump.css';

/** Passcode prompt shown in place of the notes themselves. */
function LockedNotes({ unlock }: { unlock: (passcode: string) => Promise<boolean> }) {
  const [passcode, setPasscode] = useState('');
  const [wrong, setWrong] = useState(false);

  const submit = async () => {
    if (!passcode) return;
    if (await unlock(passcode)) return;
    setWrong(true);
    setPasscode('');
  };

  return (
    <form
      className="bd-lock"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="bd-label">Notes — locked</p>
      <div className="bd-actions">
        <input
          type="password"
          className="bd-lock-input"
          value={passcode}
          autoComplete="off"
          placeholder="Passcode"
          onChange={(e) => {
            setPasscode(e.target.value);
            setWrong(false);
          }}
        />
        <button type="submit" className="bd-primary" disabled={!passcode}>
          Unlock
        </button>
      </div>
      {wrong && <p className="bd-error">Wrong passcode.</p>}
    </form>
  );
}

export function NotesHistory({ limit }: { limit?: number }) {
  const lock = useNotesLock();
  const { notes, loaded, deleteNote, structureNote, confirmTasks } = useNotes(lock.privateKey);
  const ai = useBrainDumpAI();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!loaded || !lock.loaded) return null;
  if (lock.locked) return <LockedNotes unlock={lock.unlock} />;
  if (notes.length === 0) return null;
  const shown = limit ? notes.slice(0, limit) : notes;
  const aiUsable = ai.engine !== 'none';

  const restructure = async (note: BrainDumpNote) => {
    setBusyId(note.id);
    try {
      await structureNote(note.id, note.rawText);
    } catch {
      // Note is marked failed by the hook; row shows Retry
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="bd-history">
      <div className="bd-history-head">
        <p className="bd-label">Notes</p>
        {lock.enabled && (
          <button className="bd-ghost small" title="Hide notes again" onClick={() => void lock.lock()}>
            Lock
          </button>
        )}
      </div>
      {shown.map((note) => (
        <div key={note.id} className="bd-note">
          <div className="bd-note-head">
            <span className="bd-note-date">{formatRelativeDate(new Date(note.createdAt))}</span>
            <span className="bd-note-head-actions">
              {note.status !== 'structured' && aiUsable && (
                <button
                  className="bd-ghost small"
                  disabled={busyId === note.id}
                  onClick={() => void restructure(note)}
                >
                  {busyId === note.id
                    ? 'Structuring…'
                    : note.status === 'failed'
                      ? 'Retry'
                      : 'Structure now'}
                </button>
              )}
              <button
                className="bd-ghost small"
                title="Delete note"
                onClick={() => void deleteNote(note.id)}
              >
                ✕
              </button>
            </span>
          </div>

          {note.status === 'structured' ? (
            <>
              <ul className="bd-bullets small">
                {note.bullets.map((bullet, i) => (
                  <li key={i}>{bullet}</li>
                ))}
              </ul>
              {note.proposedTasks.length > 0 && (
                <div className="bd-note-tasks">
                  {note.proposedTasks.map((task, i) =>
                    task.addedTaskId !== null ? (
                      <span key={i} className="bd-task-chip added">
                        ✓ {task.text}
                      </span>
                    ) : (
                      <button
                        key={i}
                        className="bd-task-chip"
                        title="Add to task list"
                        onClick={() => void confirmTasks(note.id, [{ index: i, text: task.text }])}
                      >
                        + {task.text}
                      </button>
                    ),
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="bd-note-raw">{note.rawText.slice(0, 220)}</p>
          )}
        </div>
      ))}
    </div>
  );
}
