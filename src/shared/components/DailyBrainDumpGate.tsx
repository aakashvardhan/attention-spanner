import { useEffect, useMemo, useState } from 'react';
import {
  structureBrainDump,
  type StructuredDump,
} from '../ai/brainDump';
import {
  DAILY_BRAIN_DUMP_MIN_VISIBLE_CHARS,
  MAX_DUMP_CHARS,
  NEWTAB_PAGE_PATH,
} from '../constants';
import {
  basicBrainDumpBullets,
  isDailyBrainDumpComplete,
  visibleCharacterCount,
} from '../dailyBrainDump';
import { intentFromRecommendation } from '../attention';
import { useStorageValue } from '../hooks/useStorageValue';
import { sendMessage } from '../messages';
import { setLocal } from '../storage';
import './dailyBrainDumpGate.css';

interface DailyBrainDumpGateProps {
  onContinue?: () => void;
}

type InitialState = 'loading' | 'locked' | 'complete';
type GateStage =
  | { name: 'entry' }
  | { name: 'saving' }
  | { name: 'structuring'; downloadProgress: number | null }
  | { name: 'review'; result: StructuredDump; basic: boolean; noteId: string };

export function DailyBrainDumpGate({ onContinue }: DailyBrainDumpGateProps) {
  const [gate, loaded] = useStorageValue('dailyBrainDumpGate');
  const [text, setText] = useState('');
  const [stage, setStage] = useState<GateStage>({ name: 'entry' });
  const [submittedHere, setSubmittedHere] = useState(false);
  const [error, setError] = useState('');
  const [initialState, setInitialState] = useState<InitialState>('loading');
  const count = useMemo(() => visibleCharacterCount(text), [text]);
  const complete = isDailyBrainDumpComplete(gate);

  useEffect(() => {
    if (!loaded || initialState !== 'loading') return;
    setInitialState(complete ? 'complete' : 'locked');
  }, [loaded, complete, initialState]);

  // A persistent redirect can catch restored tabs before the worker reinstalls
  // today's session allow. If today was already complete, heal that bounce
  // automatically; it is not a new gate cycle.
  const submit = async () => {
    if (count < DAILY_BRAIN_DUMP_MIN_VISIBLE_CHARS || stage.name !== 'entry') return;
    const rawText = text.trim();
    setStage({ name: 'saving' });
    setError('');
    try {
      const saved = await sendMessage({ type: 'SAVE_NOTE', rawText });
      if (!saved.dailyGateCompleted) {
        setError('Add a little more detail before starting the day.');
        setStage({ name: 'entry' });
        return;
      }
      setSubmittedHere(true);
      setText('');
      setStage({ name: 'structuring', downloadProgress: null });
      try {
        const result = await structureBrainDump(rawText, {
          onDownloadProgress: (downloadProgress) =>
            setStage({ name: 'structuring', downloadProgress }),
        });
        await sendMessage({
          type: 'STRUCTURE_NOTE_RESULT',
          id: saved.note.id,
          bullets: result.bullets,
          tasks: result.tasks,
        });
        setStage({
          name: 'review',
          result: { bullets: result.bullets.slice(0, 3), tasks: result.tasks.slice(0, 1) },
          basic: false,
          noteId: saved.note.id,
        });
      } catch {
        const result = { bullets: basicBrainDumpBullets(rawText), tasks: [] };
        await sendMessage({
          type: 'STRUCTURE_NOTE_RESULT',
          id: saved.note.id,
          bullets: result.bullets,
          tasks: [],
        });
        setStage({ name: 'review', result, basic: true, noteId: saved.note.id });
      }
    } catch {
      setError('Your note could not be saved. Nothing was unlocked—please try again.');
      setStage({ name: 'entry' });
    }
  };

  const continueDay = () => {
    if (onContinue) onContinue();
    else location.replace(chrome.runtime.getURL(NEWTAB_PAGE_PATH));
  };

  const useAsNow = async (recommendation: string, noteId: string) => {
    await setLocal({ activeIntent: intentFromRecommendation(recommendation, noteId) });
    continueDay();
  };

  if (!loaded || initialState === 'loading') {
    return (
      <main className="daily-gate daily-gate--center" aria-busy="true">
        <div className="daily-gate-spinner" />
        <p>Preparing today’s workspace…</p>
      </main>
    );
  }

  if (stage.name === 'saving' || stage.name === 'structuring') {
    const progress = stage.name === 'structuring' ? stage.downloadProgress : null;
    return (
      <main className="daily-gate">
        <section className="daily-gate-card daily-gate-progress-card" aria-live="polite">
          <div className="daily-gate-spinner" />
          <h1>{stage.name === 'saving' ? 'Saving your dump…' : 'Turning it into a clear outline…'}</h1>
          <p className="daily-gate-sub">
            Your raw thoughts are already safe. This review step makes them easier to scan.
          </p>
          {progress !== null && (
            <div className="daily-gate-progress" aria-label="AI model download progress">
              <div style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
        </section>
      </main>
    );
  }

  if (stage.name === 'review') {
    const bullets =
      stage.result.bullets.length > 0 ? stage.result.bullets : stage.result.tasks;
    const recommendation = stage.result.tasks[0] ?? stage.result.bullets[0] ?? '';
    return (
      <main className="daily-gate">
        <section className="daily-gate-card" aria-labelledby="daily-review-title">
          <p className="daily-gate-eyebrow">Your morning outline</p>
          <h1 id="daily-review-title">Here’s what’s on your mind.</h1>
          <ul className="daily-gate-bullets">
            {bullets.map((bullet, index) => <li key={`${index}-${bullet}`}>{bullet}</li>)}
          </ul>
          {recommendation && (
            <div className="daily-gate-actions-list">
              <h2>One possible place to start</h2>
              <p>{recommendation}</p>
            </div>
          )}
          {stage.basic && (
            <p className="daily-gate-basic-note">
              Basic offline outline shown because an AI structuring engine was unavailable.
            </p>
          )}
          <div className="daily-gate-review-buttons">
            {recommendation && (
              <button
                className="daily-gate-primary"
                onClick={() => void useAsNow(recommendation, stage.noteId)}
              >
                Use as Now
              </button>
            )}
            <button className="daily-gate-secondary" onClick={continueDay}>
              Continue without choosing
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (complete && initialState === 'locked') {
    return (
      <main className="daily-gate daily-gate--center">
        <div className="daily-gate-check" aria-hidden="true">✓</div>
        <h1>{submittedHere ? 'Brain dump saved.' : 'You’re clear for today.'}</h1>
        <p className="daily-gate-sub">Your brain dump was completed from another surface.</p>
        <button className="daily-gate-primary" onClick={continueDay}>Open my dashboard</button>
      </main>
    );
  }

  const remaining = Math.max(0, DAILY_BRAIN_DUMP_MIN_VISIBLE_CHARS - count);
  return (
    <main className="daily-gate">
      <section className="daily-gate-card" aria-labelledby="daily-gate-title">
        <p className="daily-gate-eyebrow">Before the internet</p>
        <h1 id="daily-gate-title">Clear your head first.</h1>
        <p className="daily-gate-sub">
          Put down whatever is pulling at your attention—tasks, worries, reminders, unfinished
          thoughts. It is saved locally before browsing opens.
        </p>
        <label className="daily-gate-label" htmlFor="daily-brain-dump">
          What’s on your mind?
        </label>
        <textarea
          id="daily-brain-dump"
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="Everything goes here—messy is fine…"
          rows={9}
          maxLength={MAX_DUMP_CHARS}
        />
        <div className="daily-gate-meta">
          <span>
            {remaining > 0
              ? `${remaining} more non-space character${remaining === 1 ? '' : 's'}`
              : 'Ready to save'}
          </span>
          <span>⌘/Ctrl + Enter</span>
        </div>
        {error && <p className="daily-gate-error" role="alert">{error}</p>}
        <button
          className="daily-gate-primary"
          disabled={remaining > 0}
          onClick={() => void submit()}
        >
          Save, structure & review
        </button>
        <p className="daily-gate-privacy">
          Saved before structuring. If AI is unavailable, you’ll still get a basic offline outline.
        </p>
        {/* The dump used to hold every tab in the browser hostage until it was
            written. Keeping it as the first thing on a new tab is the useful
            half; making it compulsory is what turned it into a morning toll. */}
        <button className="daily-gate-skip" onClick={continueDay}>
          Skip for today
        </button>
      </section>
    </main>
  );
}
