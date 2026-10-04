import { useEffect, useRef, useState } from 'react';
import {
  ASK_TIMEOUT_MS,
  FEELING_QUESTION,
  MAX_DUMP_CHARS,
  MAX_STEP_TRIES,
  NEXT_STEP_SYSTEM,
  STEP_SIZE_QUESTION,
  askErrorMessage,
  completeStep,
  hoursShare,
  isOnlyFeeling,
  isTooBig,
  parkDump,
  parseNextStep,
  removeDump,
  retryPrompt,
  setNextStep,
  stepProblem,
} from '../../shared/brainDump';
import { CLAUDE_MODELS } from '../../shared/constants';
import { formatRelativeDate } from '../../shared/format';
import { useSettings } from '../../shared/hooks/useSettings';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { claudeStream } from '../../shared/llm/claude';
import { clip, layaReady, systemOne } from '../../shared/llm/laya';
import { chat, health, warm } from '../../shared/llm/ollama';
import { getLocal, setLocal } from '../../shared/storage';
import type { Dump } from '../../shared/types';

const NOTHING_TO_DO = "Nothing to act on. It's parked.";

/**
 * Type whatever is looping, park it, and the box clears. Past dumps sit behind
 * a closed "Parked (N)" so the page never lists your open loops back at you.
 * The local model then offers one small next step; tick it off and it offers
 * the next, until it says there is nothing left and the loop is closed. Laya
 * and Ollama run on device. A dump is private, so it reaches Claude Haiku only
 * when the local model can't answer and you click "Ask Claude Haiku" on that
 * dump; cloud must be on in Settings with a key. The dump is saved first.
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
  /** What Laya and Ollama did on the last ask, one line per stage, so the work is visible */
  const [trace, setTrace] = useState<string[]>([]);
  /** You sent this dump to Claude, so its later steps go there too */
  const [viaCloud, setViaCloud] = useState(false);
  const warmed = useRef(false);
  /** The ask in flight. A new ask, a pick-up or leaving the page cancels it, so two never race. */
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  const parked = dumps.find((d) => d.id === parkedId);
  const cloudReady = settings.cloudMode !== 'off' && settings.claudeKey !== '' && navigator.onLine;

  // ponytail: read-modify-write from the page, so two new tabs writing in the
  // same instant lose one; route through a background message if that bites.
  const write = async (change: (list: Dump[]) => Dump[]) => {
    const { dumps: current } = await getLocal('dumps');
    const next = change(current);
    await setLocal({ dumps: next });
    return next;
  };

  /** write() for a click: a failed save (storage quota) is shown, and null tells the caller to stop. */
  const save = async (change: (list: Dump[]) => Dump[]) => {
    try {
      return await write(change);
    } catch (err) {
      setError(`Couldn't save the brain dump${err instanceof Error && err.message ? `: ${err.message}` : '.'}`);
      return null;
    }
  };

  const park = async () => {
    if (!text.trim()) return;
    // On a failed save the text stays in the box, so nothing typed is lost.
    const next = await save((list) => parkDump(list, text, Date.now()));
    if (!next) return;
    setText('');
    if (await pickUp(next[0].id)) void askNextStep(next[0]);
  };

  /** Probed only when a dump is opened, not on every new tab. */
  const pickUp = async (id: string) => {
    inFlight.current?.abort();
    setParkedId(id);
    setLive(null);
    setError('');
    setTrace([]);
    setViaCloud(false);
    // No chat model picked means you chose no local AI: say nothing. A picked one that
    // cannot answer gets a reason, or "Parked." alone would hide why no step came.
    if (!settings.ollamaChatModel) {
      setAiUp(false);
      return false;
    }
    const h = await health(settings.ollamaUrl);
    if (!h.ok) {
      setTrace([
        h.kind === 'forbidden'
          ? 'Ollama · refused this extension; Settings → Local AI shows the fix'
          : h.kind === 'offline'
            ? 'Ollama · not running'
            : 'Ollama · not answering',
      ]);
    }
    setAiUp(h.ok);
    return h.ok;
  };

  const askNextStep = async (dump: Dump, cloud = false) => {
    inFlight.current?.abort();
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    /** False once a newer ask, a pick-up or unmount took over; nothing from this one may show then */
    const current = () => !ctrl.signal.aborted;
    const onText = (t: string) => current() && setLive(t);
    setLive('');
    setError('');
    const lines: string[] = [];
    /** Adds a stage line, or rewrites the last one when that stage finishes */
    const log = (line: string, replaceLast = false) => {
      if (!current()) return;
      if (replaceLast) lines.pop();
      lines.push(line);
      setTrace([...lines]);
    };
    const rejected: { step: string; why: string }[] = [];
    let timedOut = false;
    const who = cloud ? 'Claude' : 'Ollama';
    const model = cloud ? `Claude · ${CLAUDE_MODELS.quick}` : `Ollama · ${settings.ollamaChatModel}`;
    try {
      const layaUp = await layaReady(settings.layaUrl);
      if (dump.done?.length) {
        log(`Laya · skipped: with steps done, ${who} decides when the loop is closed`);
      } else if (!layaUp) {
        log(settings.layaUrl ? `Laya · not running, ${who} alone` : `Laya · off, ${who} alone`);
      } else {
        log('Laya · is this only a feeling…');
        const start = performance.now();
        // Laya reads the first 512 tokens; clip at a word so the cut is visible, not mid-word.
        const { feeling } = await systemOne(
          settings.layaUrl,
          { dump: clip(dump.text, 1800) },
          { feeling: FEELING_QUESTION },
          ctrl.signal,
        ).catch(() => ({ feeling: undefined }));
        if (!current()) return;
        const p =
          feeling?.type === 'noul' && Number.isFinite(feeling.noul)
            ? `feeling ${Math.round(feeling.noul * 100)}%, ${took(start)}`
            : '';
        if (isOnlyFeeling(feeling)) {
          log(`Laya · only a feeling (${p}), ${who} not needed`, true);
          await save((list) => setNextStep(list, dump.id, null));
          return;
        }
        log(p ? `Laya · something to act on (${p})` : `Laya · no answer, ${who} alone`, true);
      }
      const ask = (prompt: string) => {
        const timeout = AbortSignal.timeout(ASK_TIMEOUT_MS);
        timeout.addEventListener('abort', () => (timedOut = true));
        const signal = AbortSignal.any([ctrl.signal, timeout]);
        return cloud
          ? claudeStream({
              apiKey: settings.claudeKey,
              model: CLAUDE_MODELS.quick,
              system: NEXT_STEP_SYSTEM,
              document: prompt,
              prompt: 'Reply with the next step.',
              signal,
              onText,
            })
          : chat({
              url: settings.ollamaUrl,
              model: settings.ollamaChatModel,
              messages: [
                { role: 'system', content: NEXT_STEP_SYSTEM },
                { role: 'user', content: prompt },
              ],
              signal,
              onText,
              // One short imperative needs no reasoning: under 1 s instead of ~17 s, same steps on the bench.
              think: false,
            });
      };

      // The self-check loop: every step is checked before you see it, and a
      // failing one is sent back with the reason, up to MAX_STEP_TRIES.
      let step: string | null = null;
      for (let attempt = 1; ; attempt++) {
        log(`${model} · try ${attempt}, working…`);
        setLive('');
        const start = performance.now();
        step = parseNextStep(await ask(retryPrompt(dump, rejected)));
        if (!step) {
          if (rejected.length) {
            // NONE right after a rejection is the model giving up, not the loop closing.
            step = rejected[rejected.length - 1].step;
            log(`${model} · try ${attempt}: NONE, keeping try ${attempt - 1}, ${took(start)}`, true);
          } else {
            log(`${model} · NONE, nothing left, ${took(start)}`, true);
          }
          break;
        }
        log(`${model} · try ${attempt}: "${step}", ${took(start)}`, true);
        let why = stepProblem(step, dump);
        let size = '';
        if (!why && layaUp) {
          const { size: answer } = await systemOne(
            settings.layaUrl,
            { step },
            { size: STEP_SIZE_QUESTION },
            ctrl.signal,
          ).catch(() => ({ size: undefined }));
          const share = hoursShare(answer);
          if (share !== null) size = `, hours ${Math.round(share * 100)}%`;
          if (isTooBig(answer)) why = 'too big for 10 minutes';
        }
        if (!why) {
          log(`Check · passed (one action, new${size})`);
          break;
        }
        if (attempt === MAX_STEP_TRIES) {
          log(`Check · ${why}${size}, kept after ${attempt} tries`);
          break;
        }
        log(`Check · ${why}${size}, asking again`);
        rejected.push({ step, why });
      }
      if (!current()) return;
      await save((list) => setNextStep(list, dump.id, step));
    } catch (err) {
      if (!current()) return;
      // A retry that fails still leaves the last rejected try, which is a usable step.
      const kept = rejected.at(-1)?.step;
      if (kept) {
        log(`${model} · try ${rejected.length + 1} failed, keeping try ${rejected.length}`, true);
        await save((list) => setNextStep(list, dump.id, kept));
        return;
      }
      log(`${model} · no answer`, lines.at(-1)?.startsWith(model));
      setError(askErrorMessage(err, who, timedOut));
    } finally {
      if (inFlight.current === ctrl) {
        inFlight.current = null;
        setLive(null);
      }
    }
  };

  const tickOff = async (dump: Dump) => {
    const next = await save((list) => completeStep(list, dump.id));
    const updated = next?.find((d) => d.id === dump.id);
    if (updated && (viaCloud || aiUp)) void askNextStep(updated, viaCloud);
  };

  const askClaude = (dump: Dump) => {
    setViaCloud(true);
    void askNextStep(dump, true);
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
        // Clicking into the box is the signal a dump is coming: load the model
        // while you type, once per page, so the first step is not a cold start.
        onFocus={() => {
          if (warmed.current || !settings.ollamaChatModel) return;
          warmed.current = true;
          warm(settings.ollamaUrl, settings.ollamaChatModel);
        }}
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
        {parked && cloudReady && parked.nextStep === undefined && live === null && (!aiUp || error) && (
          <button type="button" className="relay-recap-toggle" onClick={() => askClaude(parked)}>
            Ask Claude Haiku
          </button>
        )}
      </div>
      {parked?.done?.length ? <p className="edition-dump-note">Done: {parked.done.join(' · ')}</p> : null}
      {parked && (live !== null || parked.nextStep !== undefined) && (
        <p className="edition-dump-step" aria-live="polite">
          {live ?? stepText(parked)}
        </p>
      )}
      {parked?.nextStep && live === null && (
        <div className="edition-dump-actions">
          <button type="button" className="edition-pill" onClick={() => void tickOff(parked)}>
            Done
          </button>
          <button
            type="button"
            className="relay-recap-toggle"
            onClick={() => void save((list) => setNextStep(list, parked.id, null))}
          >
            Close the loop
          </button>
        </div>
      )}
      {error && <p className="edition-dump-step">{error}</p>}
      {parked &&
        // Index keys: the same line can repeat ("two actions joined, asking again").
        trace.map((line, i) => (
          <p key={i} className="edition-dump-note">
            {line}
          </p>
        ))}

      {dumps.length > 0 && (
        <details className="edition-dump-parked">
          <summary>Parked ({dumps.length})</summary>
          <ul>
            {dumps.map((dump) => (
              <li key={dump.id}>
                <span className="edition-dump-note">{formatRelativeDate(new Date(dump.createdAt))}</span>
                <p className="edition-dump-text">{dump.text}</p>
                {dump.nextStep !== undefined && <p className="edition-dump-note">{stepText(dump)}</p>}
                {dump.nextStep !== null && dump.id !== parkedId && (
                  <button
                    type="button"
                    className="relay-recap-toggle edition-dump-delete"
                    onClick={() => void pickUp(dump.id)}
                  >
                    Pick up
                  </button>
                )}
                <button
                  type="button"
                  className="relay-recap-toggle edition-dump-delete"
                  onClick={() => void save((list) => removeDump(list, dump.id))}
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

function took(start: number): string {
  const ms = performance.now() - start;
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function stepText(dump: Dump): string {
  if (dump.nextStep) return `Next: ${dump.nextStep}`;
  const n = dump.done?.length ?? 0;
  return n ? `Loop closed after ${n} step${n === 1 ? '' : 's'}.` : NOTHING_TO_DO;
}
