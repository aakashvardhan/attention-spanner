import { useEffect, useState } from 'react';
import { suggestFirstAction } from '../ai/ignition';
import { useBrainDumpAI } from '../hooks/useBrainDumpAI';
import { sendMessage } from '../messages';
import type { Task } from '../types';
import './ignition.css';

const MICRO_SPRINT_MINUTES = 5;

/**
 * Ignition card — appears under a task row. On-device AI proposes a tiny
 * first action; one click starts a short blocking micro-sprint scoped to the
 * task. Degrades to a plain "start tiny" sprint when Nano is unavailable.
 */
export function IgnitionCard({ task, onClose }: { task: Task; onClose: () => void }) {
  const { availability, checked } = useBrainDumpAI();
  const aiReady = availability === 'available';
  const [action, setAction] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [failed, setFailed] = useState(false);

  const suggest = async () => {
    setThinking(true);
    setFailed(false);
    try {
      setAction(await suggestFirstAction(task.text));
    } catch {
      setFailed(true);
    } finally {
      setThinking(false);
    }
  };

  useEffect(() => {
    if (checked && aiReady) void suggest();
    // Run once when availability resolves; regenerate is explicit via ↻
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, aiReady]);

  const start = async () => {
    onClose();
    await sendMessage({
      type: 'START_FOCUS',
      mode: 'oneshot',
      focusMinutes: MICRO_SPRINT_MINUTES,
      breakMinutes: 5,
      taskId: task.id,
      intent: action ?? task.text,
    });
  };

  return (
    <div className="ignition-card">
      {thinking ? (
        <p className="ignition-status">⚡ Finding the smallest first step…</p>
      ) : (
        <>
          <p className="ignition-action">
            → {action ?? 'Start stupidly small: two minutes on it, done badly, still counts.'}
          </p>
          {checked && !aiReady && (
            <p className="ignition-hint">On-device AI isn't available — going manual.</p>
          )}
          {failed && <p className="ignition-hint">AI didn't answer — going manual.</p>}
        </>
      )}
      <div className="ignition-actions">
        <button className="ignition-start" disabled={thinking} onClick={() => void start()}>
          ▶ Start {MICRO_SPRINT_MINUTES}-min sprint
        </button>
        {aiReady && (
          <button
            className="ignition-ghost"
            title="Suggest a different first step"
            disabled={thinking}
            onClick={() => void suggest()}
          >
            ↻
          </button>
        )}
        <button className="ignition-ghost" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>
    </div>
  );
}
