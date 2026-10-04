import { Fragment, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  ASK_TIMEOUT_MS,
  FEELING_QUESTION,
  MAX_DUMP_CHARS,
  MAX_STEP_TRIES,
  RECURRING_QUESTION,
  STEP_SIZE_QUESTION,
  askErrorMessage,
  completeStep,
  doneToday,
  hoursShare,
  isDue,
  isOnlyFeeling,
  isRecurring,
  isTooBig,
  keepAfterRetries,
  parkDump,
  parseNextStep,
  removeDump,
  retryPrompt,
  setKind,
  setNextStep,
  stepProblem,
  systemFor,
  traceStages,
} from '../../shared/brainDump';
import { CLAUDE_MODELS } from '../../shared/constants';
import { formatRelativeDate } from '../../shared/format';
import { useSettings } from '../../shared/hooks/useSettings';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { claudeStream } from '../../shared/llm/claude';
import { clip, layaReady, systemOne, type LayaAnswer } from '../../shared/llm/laya';
import { chat, health, warm } from '../../shared/llm/ollama';
import { getLocal, setLocal } from '../../shared/storage';
import type { Dump } from '../../shared/types';

const NOTHING_TO_DO = "Nothing to act on. It's parked.";
/** Done steps listed above the card; older ones fold into "N earlier" */
const SHOWN_DONE = 3;
/** How long the check fills before the step moves into the done list, so the tap reads as done */
const CHECK_MS = 360;

/**
 * Type whatever is looping, park it, and the box clears. Past dumps sit behind
 * a closed "Parked (N)" so the page never lists your open loops back at you.
 * The local model then offers one small next step; tick it off and it offers
 * the next, until it says there is nothing left and the loop is closed. A dump
 * Laya reads as recurring ("get better at leetcode") never closes on its own:
 * it gets one step a day, each about 1% further, and on a new day that step
 * comes to the new tab by itself. Laya
 * and Ollama run on device. A dump is private, so it reaches Claude Haiku only
 * when the local model can't answer and you click "Ask Claude Haiku" on that
 * dump; cloud must be on in Settings with a key. The dump is saved first.
 */
export function BrainDump() {
  const [settings, settingsLoaded] = useSettings();
  const [dumps, dumpsLoaded] = useStorageValue('dumps');
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
  /** The step's check is filling; the step moves to the done list when it finishes */
  const [checking, setChecking] = useState(false);
  /** Index in `done` of the step just ticked off, so only it slides in */
  const [justDone, setJustDone] = useState<number | null>(null);
  /** "Parked." confirms a park; a practice that surfaced on its own was not just parked */
  const [justParked, setJustParked] = useState(false);
  const warmed = useRef(false);
  const sectionRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** The ask in flight. A new ask, a pick-up or leaving the page cancels it, so two never race. */
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);
  const surfaced = useRef(false);

  const parked = dumps.find((d) => d.id === parkedId);
  /** A practice whose step for today is done: it rests until tomorrow */
  const restingToday = parked?.kind === 'recurring' && parked.nextStep === undefined && doneToday(parked, Date.now());
  const stepLabel = parked?.kind === 'recurring' ? `Today's 1% · Day ${(parked.done?.length ?? 0) + 1}` : 'Next step';
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
    if (inputRef.current && sectionRef.current) flyToParked(inputRef.current, sectionRef.current, text);
    setText('');
    const up = await pickUp(next[0].id);
    setJustParked(true);
    if (up) void askNextStep(next[0]);
  };

  /** Probed only when a dump is opened, not on every new tab. */
  const pickUp = async (id: string) => {
    inFlight.current?.abort();
    setParkedId(id);
    setLive(null);
    setError('');
    setTrace([]);
    setViaCloud(false);
    setChecking(false);
    setJustDone(null);
    setJustParked(false);
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
      const askFeeling = !dump.done?.length;
      const askKind = dump.kind === undefined;
      if (!layaUp) {
        log(settings.layaUrl ? `Laya · not running, ${who} alone` : `Laya · off, ${who} alone`);
      } else if (!askFeeling && !askKind) {
        log(
          dump.kind === 'recurring'
            ? 'Laya · skipped: a practice, one step a day'
            : `Laya · skipped: with steps done, ${who} decides when the loop is closed`,
        );
      } else {
        log('Laya · reading the dump…');
        const start = performance.now();
        // Both questions share the dump, so they go in one forward pass. Laya reads the
        // first 512 tokens; clip at a word so the cut is visible, not mid-word.
        const { feeling, kind } = await systemOne<'feeling' | 'kind'>(
          settings.layaUrl,
          { dump: clip(dump.text, 1800) },
          { ...(askFeeling ? { feeling: FEELING_QUESTION } : {}), ...(askKind ? { kind: RECURRING_QUESTION } : {}) },
          ctrl.signal,
        ).catch((): { feeling?: LayaAnswer; kind?: LayaAnswer } => ({}));
        if (!current()) return;
        const parts: string[] = [];
        if (feeling?.type === 'noul' && Number.isFinite(feeling.noul)) {
          parts.push(`feeling ${Math.round(feeling.noul * 100)}%`);
        }
        const better =
          kind?.type === 'choice' ? (kind.probabilities as Record<string, unknown>)?.['keep getting better'] : null;
        if (typeof better === 'number' && Number.isFinite(better)) {
          parts.push(`keep getting better ${Math.round(better * 100)}%`);
          // Decided once and kept: a malformed answer decides nothing, and is asked again next time.
          dump = { ...dump, kind: isRecurring(kind) ? 'recurring' : 'task' };
          const decided = dump.kind;
          await save((list) => setKind(list, dump.id, decided));
        }
        const p = parts.length ? `${parts.join(', ')}, ${took(start)}` : '';
        // Just found to be a practice, with today's step already ticked off: today is done.
        if (dump.kind === 'recurring' && doneToday(dump, Date.now())) {
          log(`Laya · a practice (${p}): today's step is done, the next comes tomorrow`, true);
          return;
        }
        if (askFeeling && isOnlyFeeling(feeling)) {
          log(`Laya · only a feeling (${p}), ${who} not needed`, true);
          await save((list) => setNextStep(list, dump.id, null));
          return;
        }
        log(
          !p
            ? `Laya · no answer, ${who} alone`
            : dump.kind === 'recurring'
              ? `Laya · a practice (${p}): one step a day`
              : `Laya · something to act on (${p})`,
          true,
        );
      }
      const ask = (prompt: string) => {
        const timeout = AbortSignal.timeout(ASK_TIMEOUT_MS);
        timeout.addEventListener('abort', () => (timedOut = true));
        const signal = AbortSignal.any([ctrl.signal, timeout]);
        return cloud
          ? claudeStream({
              apiKey: settings.claudeKey,
              model: CLAUDE_MODELS.quick,
              system: systemFor(dump),
              document: prompt,
              prompt: dump.kind === 'recurring' ? "Reply with today's session." : 'Reply with the next step.',
              signal,
              onText,
            })
          : chat({
              url: settings.ollamaUrl,
              model: settings.ollamaChatModel,
              messages: [
                { role: 'system', content: systemFor(dump) },
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
      /** No try passed and none is worth keeping: leave the step unasked rather than close the loop */
      let gaveUp = false;
      for (let attempt = 1; ; attempt++) {
        log(`${model} · try ${attempt}, working…`);
        setLive('');
        const start = performance.now();
        const reply = parseNextStep(await ask(retryPrompt(dump, rejected)));
        let why: string | null;
        let size = '';
        if (!reply) {
          if (dump.kind !== 'recurring' && !rejected.length) {
            log(`${model} · NONE, nothing left, ${took(start)}`, true);
            break;
          }
          log(`${model} · try ${attempt}: NONE, ${took(start)}`, true);
          // NONE after a rejection is the model giving up, not the loop closing; a practice never runs out.
          why = dump.kind === 'recurring' ? 'a practice has no end' : 'gave up';
        } else {
          log(`${model} · try ${attempt}: "${reply}", ${took(start)}`, true);
          why = stepProblem(reply, dump);
          // A practice session is meant to take a while, so the 10-minute size check is for tasks.
          if (!why && layaUp && dump.kind !== 'recurring') {
            const { size: answer } = await systemOne(
              settings.layaUrl,
              { step: reply },
              { size: STEP_SIZE_QUESTION },
              ctrl.signal,
            ).catch(() => ({ size: undefined }));
            const share = hoursShare(answer);
            if (share !== null) size = `, hours ${Math.round(share * 100)}%`;
            if (isTooBig(answer)) why = 'too big for 10 minutes';
          }
          if (!why) {
            log(`Check · passed (${dump.kind === 'recurring' ? 'new, not counting' : 'one action, new'}${size})`);
            step = reply;
            break;
          }
        }
        rejected.push({ step: reply ?? 'NONE', why });
        if (attempt === MAX_STEP_TRIES || why === 'gave up') {
          step = keepAfterRetries(rejected);
          gaveUp = step === null;
          log(
            step
              ? `Check · ${why}${size}, keeping "${step}" after ${attempt} tries`
              : `Check · ${why}${size}, no new step after ${attempt} tries`,
          );
          break;
        }
        log(`Check · ${why}${size}, asking again`);
      }
      if (!current() || gaveUp) return;
      await save((list) => setNextStep(list, dump.id, step));
    } catch (err) {
      if (!current()) return;
      // A retry that fails can still leave a usable earlier try; never a repeat.
      const kept = keepAfterRetries(rejected);
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
    const next = await save((list) => completeStep(list, dump.id, Date.now()));
    const updated = next?.find((d) => d.id === dump.id);
    // A practice's next step is tomorrow's, and comes to the new tab on its own.
    if (updated && updated.kind !== 'recurring' && (viaCloud || aiUp)) void askNextStep(updated, viaCloud);
  };

  // On a new day, a practice that is due comes to the panel by itself, and its
  // step is asked if there is none yet. Once per page, and never over a dump
  // you are already working on.
  useEffect(() => {
    if (surfaced.current || !dumpsLoaded || !settingsLoaded || parkedId) return;
    surfaced.current = true;
    const due = dumps.find((d) => isDue(d, Date.now()));
    if (!due) return;
    void pickUp(due.id).then((up) => {
      if (up && due.nextStep === undefined) void askNextStep(due);
    });
  });

  /** Tap the circle: it fills and checks, then the step slides up into the done list. */
  const check = async (dump: Dump) => {
    setChecking(true);
    await new Promise((resolve) => setTimeout(resolve, CHECK_MS));
    setJustDone(dump.done?.length ?? 0);
    setChecking(false);
    await tickOff(dump);
  };

  const askClaude = (dump: Dump) => {
    setViaCloud(true);
    void askNextStep(dump, true);
  };

  return (
    <section ref={sectionRef} className="edition-dump" aria-labelledby="dump-title">
      <p id="dump-title" className="edition-kicker">
        Brain dump
      </p>
      <textarea
        ref={inputRef}
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
        {parked && justParked && <span className="edition-dump-note">Parked.</span>}
        {parked && aiUp && parked.nextStep === undefined && live === null && !restingToday && (
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
      {parked && (
        <div className="dump-loop">
          {parked.done?.length ? (
            <ol className="dump-done" aria-label="Steps done">
              {parked.done.length > SHOWN_DONE && (
                <li className="dump-done-earlier">{parked.done.length - SHOWN_DONE} earlier</li>
              )}
              {parked.done.slice(-SHOWN_DONE).map((step, i, shown) => {
                const index = parked.done!.length - shown.length + i;
                return (
                  <li
                    key={`${index}:${step}`}
                    className={index === justDone ? 'dump-done-item is-new' : 'dump-done-item'}
                  >
                    <CheckMark />
                    <span>{step}</span>
                  </li>
                );
              })}
            </ol>
          ) : null}

          {live !== null ? (
            <div className="dump-card is-working" aria-busy="true">
              <p className="dump-card-label">{stepLabel}</p>
              {live ? (
                <p className="dump-card-text" aria-live="polite">
                  <Words text={live} />
                </p>
              ) : (
                <span className="dump-shimmer" role="status" aria-label="Working on the next step">
                  <span />
                  <span />
                </span>
              )}
            </div>
          ) : parked.nextStep ? (
            // Keyed by the step, so each new one rises in rather than swapping text in place.
            <div key={parked.nextStep} className={checking ? 'dump-card is-checking' : 'dump-card'}>
              <button
                type="button"
                className="dump-check"
                aria-label="Done"
                disabled={checking}
                onClick={() => void check(parked)}
              >
                <svg viewBox="0 0 28 28" aria-hidden="true">
                  <circle cx="14" cy="14" r="12.5" />
                  <path d="M9 14.5l3.5 3.5 7-7.5" />
                </svg>
              </button>
              <div className="dump-card-body">
                <p className="dump-card-label">{stepLabel}</p>
                <p className="dump-card-text" aria-live="polite">
                  <Words text={parked.nextStep} />
                </p>
                <button
                  type="button"
                  className="relay-recap-toggle dump-close"
                  onClick={() => void save((list) => setNextStep(list, parked.id, null))}
                >
                  Close the loop
                </button>
              </div>
            </div>
          ) : restingToday ? (
            <div className="dump-card is-closed has-ring" role="status">
              <span className="dump-ring-wrap">
                <svg className="dump-ring" viewBox="0 0 32 32" aria-hidden="true">
                  <circle className="dump-ring-track" cx="16" cy="16" r="12" />
                  <circle className="dump-ring-fill" cx="16" cy="16" r="12" />
                  <path className="dump-ring-check" d="M11 16.5l3.5 3.5 6.5-7" />
                </svg>
              </span>
              <div className="dump-card-body">
                <p className="dump-card-text">Day {parked.done?.length ?? 0} done</p>
                <p className="dump-card-note">Tomorrow's 1% comes on its own.</p>
              </div>
            </div>
          ) : parked.nextStep === null ? (
            <div className={parked.done?.length ? 'dump-card is-closed has-ring' : 'dump-card is-closed'} role="status">
              {parked.done?.length ? (
                <span className="dump-ring-wrap">
                  <svg className="dump-ring" viewBox="0 0 32 32" aria-hidden="true">
                    <circle className="dump-ring-track" cx="16" cy="16" r="12" />
                    <circle className="dump-ring-fill" cx="16" cy="16" r="12" />
                    <path className="dump-ring-check" d="M11 16.5l3.5 3.5 6.5-7" />
                  </svg>
                  <span className="dump-burst" aria-hidden="true">
                    {Array.from({ length: 8 }, (_, i) => (
                      <i key={i} style={{ '--i': i } as CSSProperties} />
                    ))}
                  </span>
                </span>
              ) : null}
              <p className="dump-card-text">{closedText(parked)}</p>
            </div>
          ) : null}

          {trace.length > 0 && <TraceRow lines={trace} />}
        </div>
      )}
      {error && (
        <p className="edition-dump-step" role="alert">
          {error}
        </p>
      )}

      {dumps.length > 0 && (
        <details className="edition-dump-parked">
          <summary>
            Parked (
            <span key={dumps.length} className="dump-count">
              {dumps.length}
            </span>
            )
          </summary>
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

/**
 * Text as words that each settle into focus. Index keys, so as a reply streams
 * only the newly arrived words animate; spaces stay inside the spans so the
 * line wraps where it would anyway.
 */
function Words({ text }: { text: string }) {
  return (
    <>
      {text.split(/(?<=\s)/).map((word, i) => (
        <span key={i} className="dump-word" style={{ '--i': i } as CSSProperties}>
          {word}
        </span>
      ))}
    </>
  );
}

/**
 * The parked text, lifted off the box and flown down into "Parked (N)" with
 * the page's smooth spring. A detached element, so React never sees it; it
 * removes itself when it lands.
 */
function flyToParked(input: HTMLTextAreaElement, section: HTMLElement, text: string) {
  const from = input.getBoundingClientRect();
  const ghost = document.createElement('p');
  ghost.className = 'dump-ghost';
  ghost.textContent = text.slice(0, 280);
  Object.assign(ghost.style, {
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    transformOrigin: 'top left',
  });
  document.body.append(ghost);
  // The summary exists only once there is a dump; until it renders, aim at the section's foot.
  requestAnimationFrame(() => {
    const target = section.querySelector('.edition-dump-parked summary') ?? section;
    const to = target.getBoundingClientRect();
    const dx = to.left - from.left;
    const dy = (target === section ? to.bottom : to.top) - from.top;
    const root = getComputedStyle(document.documentElement);
    const flight = ghost.animate(
      [
        { transform: 'translate(0, 0) scale(1)', opacity: 1, filter: 'blur(0)' },
        { transform: `translate(${dx}px, ${dy}px) scale(0.2)`, opacity: 0, filter: 'blur(2px)' },
      ],
      {
        duration: cssMs(root.getPropertyValue('--dur-smooth'), 520) * 1.4,
        easing: root.getPropertyValue('--spring-smooth').trim() || 'ease-out',
        fill: 'forwards',
      },
    );
    flight.finished.then(
      () => ghost.remove(),
      () => ghost.remove(),
    );
  });
}

/** A CSS time token in ms. Chrome hands custom properties back as written or as seconds ("0.52s"). */
function cssMs(value: string, fallback: number): number {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return value.trim().endsWith('ms') ? n : n * 1000;
}

function closedText(dump: Dump): string {
  const n = dump.done?.length ?? 0;
  if (dump.kind === 'recurring') return `Practice closed · ${n} day${n === 1 ? '' : 's'}`;
  return n ? `Loop closed · ${n} step${n === 1 ? '' : 's'}` : NOTHING_TO_DO;
}

function CheckMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="8" />
      <path d="M4.5 8.2l2.3 2.3 4.7-5" />
    </svg>
  );
}

/**
 * How the step was made, as a row of stage chips; the one in flight pulses.
 * The full lines are one click away, so the work stays visible without
 * crowding the step.
 */
function TraceRow({ lines }: { lines: string[] }) {
  return (
    <details className="dump-trace">
      <summary>
        {traceStages(lines).map((stage, i) => (
          <Fragment key={stage.name}>
            {i > 0 && (
              <span className="dump-chip-sep" aria-hidden="true">
                ›
              </span>
            )}
            <span className={`dump-chip is-${stage.state}`}>
              <span className="dump-chip-dot" aria-hidden="true" />
              {stage.name}
              {stage.tries > 1 ? ` ×${stage.tries}` : ''}
            </span>
          </Fragment>
        ))}
        <svg className="dump-trace-chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M4.5 2.5L8 6l-3.5 3.5" />
        </svg>
      </summary>
      <ol className="dump-trace-lines">
        {lines.map((line, i) => (
          // Index keys: the same line can repeat ("two actions joined, asking again").
          <li key={i} style={{ '--i': i } as CSSProperties}>
            {line}
          </li>
        ))}
      </ol>
    </details>
  );
}

function stepText(dump: Dump): string {
  if (dump.kind === 'recurring' && dump.nextStep !== null) {
    const n = dump.done?.length ?? 0;
    if (dump.nextStep) return `Today, day ${n + 1}: ${dump.nextStep}`;
    return doneToday(dump, Date.now()) ? `Day ${n} done · next step tomorrow` : `Day ${n} done · today's step is due`;
  }
  if (dump.nextStep) return `Next: ${dump.nextStep}`;
  const n = dump.done?.length ?? 0;
  return n ? `Loop closed after ${n} step${n === 1 ? '' : 's'}.` : NOTHING_TO_DO;
}
