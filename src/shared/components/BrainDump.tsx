import { useState } from 'react';
import { MAX_DUMP_CHARS, structureBrainDump, type StructuredDump } from '../ai/brainDump';
import { useBrainDumpAI } from '../hooks/useBrainDumpAI';
import { sendMessage } from '../messages';
import type { Task } from '../types';
import './brainDump.css';

type Stage =
  | { name: 'idle' }
  | { name: 'working'; downloadProgress: number | null }
  | { name: 'review'; noteId: string; result: StructuredDump; checked: boolean[] }
  | { name: 'confirmed'; addedCount: number }
  | { name: 'savedRaw' };

interface BrainDumpProps {
  source: Task['source'];
  compact?: boolean;
  onDone?: () => void;
}

export function BrainDump({ compact = false, onDone }: BrainDumpProps) {
  const [text, setText] = useState('');
  const [stage, setStage] = useState<Stage>({ name: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const ai = useBrainDumpAI();

  const reset = () => {
    setStage({ name: 'idle' });
    setError(null);
  };

  const saveRawOnly = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    await sendMessage({ type: 'SAVE_NOTE', rawText: trimmed, willStructure: false });
    setText('');
    setStage({ name: 'savedRaw' });
    setTimeout(() => {
      reset();
      onDone?.();
    }, 900);
  };

  const structure = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);

    // Raw dump is persisted first — a closed window mid-inference loses nothing
    const { note } = await sendMessage({ type: 'SAVE_NOTE', rawText: trimmed, willStructure: true });
    setText('');
    setStage({ name: 'working', downloadProgress: null });

    try {
      const result = await structureBrainDump(trimmed, {
        onDownloadProgress: (fraction) =>
          setStage({ name: 'working', downloadProgress: fraction }),
      });
      await sendMessage({
        type: 'STRUCTURE_NOTE_RESULT',
        id: note.id,
        bullets: result.bullets,
        tasks: result.tasks,
      });
      void ai.refresh();
      setStage({
        name: 'review',
        noteId: note.id,
        result,
        checked: result.tasks.map(() => true),
      });
    } catch {
      await sendMessage({ type: 'NOTE_FAILED', id: note.id });
      void ai.refresh();
      setError('Structuring failed — your dump is saved in history, retry from there.');
      setStage({ name: 'idle' });
    }
  };

  const confirm = async () => {
    if (stage.name !== 'review') return;
    const taskIndexes = stage.checked.flatMap((on, i) => (on ? [i] : []));
    const res =
      taskIndexes.length > 0
        ? await sendMessage({ type: 'CONFIRM_NOTE_TASKS', id: stage.noteId, taskIndexes })
        : { ok: true, addedCount: 0 };
    setStage({ name: 'confirmed', addedCount: res.addedCount });
    setTimeout(() => {
      reset();
      onDone?.();
    }, 1200);
  };

  if (stage.name === 'working') {
    return (
      <div className="bd bd-center">
        {stage.downloadProgress !== null ? (
          <>
            <p className="bd-status">Downloading on-device AI model…</p>
            <div className="bd-progress">
              <div
                className="bd-progress-fill"
                style={{ width: `${Math.round(stage.downloadProgress * 100)}%` }}
              />
            </div>
            <p className="bd-hint">One-time download. Your dump is already saved.</p>
          </>
        ) : (
          <>
            <div className="bd-spinner" />
            <p className="bd-status">Structuring your thoughts…</p>
          </>
        )}
      </div>
    );
  }

  if (stage.name === 'review') {
    return (
      <div className="bd">
        {stage.result.bullets.length > 0 && (
          <ul className="bd-bullets">
            {stage.result.bullets.map((bullet, i) => (
              <li key={i}>{bullet}</li>
            ))}
          </ul>
        )}
        {stage.result.tasks.length > 0 ? (
          <>
            <p className="bd-label">Add as tasks?</p>
            <div className="bd-proposed">
              {stage.result.tasks.map((task, i) => (
                <label key={i} className="bd-proposed-task">
                  <input
                    type="checkbox"
                    checked={stage.checked[i]}
                    onChange={(e) => {
                      const checked = [...stage.checked];
                      checked[i] = e.target.checked;
                      setStage({ ...stage, checked });
                    }}
                  />
                  <span>{task}</span>
                </label>
              ))}
            </div>
          </>
        ) : (
          <p className="bd-hint">No actionable tasks found in this dump.</p>
        )}
        <div className="bd-actions">
          <button className="bd-primary" onClick={() => void confirm()}>
            {stage.checked.some(Boolean)
              ? `Add ${stage.checked.filter(Boolean).length} task${stage.checked.filter(Boolean).length === 1 ? '' : 's'}`
              : 'Done'}
          </button>
          <button className="bd-ghost" onClick={reset}>
            New dump
          </button>
        </div>
      </div>
    );
  }

  if (stage.name === 'confirmed' || stage.name === 'savedRaw') {
    return (
      <div className="bd bd-center">
        <p className="bd-done">
          {stage.name === 'savedRaw'
            ? '✓ Saved'
            : stage.addedCount > 0
              ? `✓ ${stage.addedCount} task${stage.addedCount === 1 ? '' : 's'} added`
              : '✓ Done'}
        </p>
      </div>
    );
  }

  const aiUsable = ai.availability === 'available' || ai.availability === 'downloadable';

  return (
    <div className="bd">
      <textarea
        className={compact ? 'bd-input compact' : 'bd-input'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && aiUsable) void structure();
        }}
        placeholder="Brain dump — type everything on your mind, unfiltered…"
        maxLength={MAX_DUMP_CHARS}
        rows={compact ? 4 : 6}
      />
      {error && <p className="bd-error">{error}</p>}
      {ai.checked && ai.availability === 'unavailable' && (
        <p className="bd-hint">
          On-device AI isn't available on this device — dumps are saved as plain notes.
        </p>
      )}
      {ai.availability === 'downloading' && (
        <p className="bd-hint">AI model is downloading — structuring unlocks when it's done.</p>
      )}
      <div className="bd-actions">
        {aiUsable && (
          <button className="bd-primary" disabled={!text.trim()} onClick={() => void structure()}>
            {ai.availability === 'downloadable' ? '✨ Enable AI & structure' : '✨ Structure'}
          </button>
        )}
        <button
          className={aiUsable ? 'bd-ghost' : 'bd-primary'}
          disabled={!text.trim()}
          onClick={() => void saveRawOnly()}
        >
          Save note
        </button>
      </div>
    </div>
  );
}
