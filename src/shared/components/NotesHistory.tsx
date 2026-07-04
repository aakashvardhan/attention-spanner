import { useState } from 'react';
import { formatRelativeDate } from '../format';
import { useBrainDumpAI } from '../hooks/useBrainDumpAI';
import { useNotes } from '../hooks/useNotes';
import type { BrainDumpNote } from '../types';
import './brainDump.css';

export function NotesHistory({ limit }: { limit?: number }) {
  const { notes, loaded, deleteNote, structureNote, confirmTasks } = useNotes();
  const ai = useBrainDumpAI();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!loaded || notes.length === 0) return null;
  const shown = limit ? notes.slice(0, limit) : notes;
  const aiUsable = ai.availability === 'available' || ai.availability === 'downloadable';

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
      <p className="bd-label">Notes</p>
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
                        onClick={() => void confirmTasks(note.id, [i])}
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
