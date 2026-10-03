import { useState } from 'react';
import { MAX_DUMP_CHARS, NEXT_STEP_SYSTEM, parkDump, parseNextStep, removeDump, setNextStep } from '../../shared/brainDump';
import { formatRelativeDate } from '../../shared/format';
import { useSettings } from '../../shared/hooks/useSettings';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { chat, health } from '../../shared/llm/ollama';
import { getLocal, setLocal } from '../../shared/storage';
import type { Dump } from '../../shared/types';

const NOTHING_TO_DO = "Nothing to act on. It's parked.";

/**
 * Type whatever is looping, park it, and the box clears. Past dumps sit behind
 * a closed "Parked (N)" so the page never lists your open loops back at you.
 * The local model can offer one small next step; Ollama only, never the cloud,
 * and the dump is saved before it is asked.
 */
export function BrainDump() {
  const [settings] = useSettings();
  const [dumps] = useStorageValue('dumps');
  const [text, setText] = useState('');
  const [parkedId, setParkedId] = useState<string | null>(null);
  const [aiUp, setAiUp] = useState(false);
  /** The model's reply while it streams; null when nothing is in flight */
  const [live, setLive] = useState<string | null>(null);
  const [error, setError] = useState('');

  const parked = dumps.find((d) => d.id === parkedId);

  // ponytail: read-modify-write from the page, so two new tabs writing in the
  // same instant lose one; route through a background message if that bites.
  const write = async (change: (list: Dump[]) => Dump[]) => {
    const { dumps: current } = await getLocal('dumps');
    const next = change(current);
    await setLocal({ dumps: next });
    return next;
  };

  const park = async () => {
    if (!text.trim()) return;
    const next = await write((list) => parkDump(list, text, Date.now()));
    setText('');
    setParkedId(next[0].id);
    setLive(null);
    setError('');
    // Probed only after a park, not on every new tab.
    setAiUp(Boolean(settings.ollamaChatModel) && (await health(settings.ollamaUrl)).ok);
  };

  const askNextStep = async (dump: Dump) => {
    setLive('');
    setError('');
    try {
      const reply = await chat({
        url: settings.ollamaUrl,
        model: settings.ollamaChatModel,
        messages: [
          { role: 'system', content: NEXT_STEP_SYSTEM },
          { role: 'user', content: dump.text },
        ],
        onText: setLive,
      });
      await write((list) => setNextStep(list, dump.id, parseNextStep(reply)));
    } catch {
      setError("Local AI didn't answer. The dump is still parked.");
    } finally {
      setLive(null);
    }
  };

  return (
    <section className="edition-dump" aria-labelledby="dump-title">
      <p id="dump-title" className="edition-kicker">
        Brain dump
      </p>
      <textarea
        className="edition-dump-input"
        aria-labelledby="dump-title"
        value={text}
        maxLength={MAX_DUMP_CHARS}
        rows={3}
        placeholder="Whatever is looping. It gets parked, out of sight."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void park();
          }
        }}
      />
      <div className="edition-dump-actions">
        <button type="button" className="edition-pill" disabled={!text.trim()} onClick={() => void park()}>
          Park it
        </button>
        {parked && <span className="edition-dump-note">Parked.</span>}
        {parked && aiUp && parked.nextStep === undefined && live === null && (
          <button type="button" className="relay-recap-toggle" onClick={() => void askNextStep(parked)}>
            One next step
          </button>
        )}
      </div>
      {parked && (live !== null || parked.nextStep !== undefined) && (
        <p className="edition-dump-step" aria-live="polite">
          {live ?? stepText(parked.nextStep)}
        </p>
      )}
      {error && <p className="edition-dump-step">{error}</p>}

      {dumps.length > 0 && (
        <details className="edition-dump-parked">
          <summary>Parked ({dumps.length})</summary>
          <ul>
            {dumps.map((dump) => (
              <li key={dump.id}>
                <span className="edition-dump-note">{formatRelativeDate(new Date(dump.createdAt))}</span>
                <p className="edition-dump-text">{dump.text}</p>
                {dump.nextStep !== undefined && <p className="edition-dump-note">{stepText(dump.nextStep)}</p>}
                <button
                  type="button"
                  className="relay-recap-toggle edition-dump-delete"
                  onClick={() => void write((list) => removeDump(list, dump.id))}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function stepText(step: string | null | undefined): string {
  return step ? `Next: ${step}` : NOTHING_TO_DO;
}
