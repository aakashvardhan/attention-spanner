import { useEffect, useRef, useState } from 'react';
import {
  executeTool,
  runAssistantTurn,
  type AssistantPhase,
} from '../ai/assistant';
import {
  newTurn,
  type AssistantPlanStep,
  type AssistantTurn,
  type TraceStep,
} from '../ai/assistantTypes';
import { cloudProviderFor, hasCloudKey } from '../ai/cloud';
import { getActiveTools } from '../ai/connector';
import { nanoProvider } from '../ai/nanoProvider';
import { cancelSpeech, speak } from '../ai/tts';
import { patchTurn, persistOutcome, persistTurn } from '../ai/turnLog';
import { sendMessage } from '../messages';
import { useBrainDumpAI } from '../hooks/useBrainDumpAI';
import { useSessionValue } from '../hooks/useSessionValue';
import { useSpeechInput } from '../hooks/useSpeechInput';
import { useStorageValue } from '../hooks/useStorageValue';
import { DEFAULT_SETTINGS, patchSettings, setSession } from '../storage';
import type { Settings } from '../types';
import type { SourceRef } from '../ai/tools';
import { Markdown } from './Markdown';
import './assistant.css';

const SUGGESTIONS = [
  'Add a task to email my advisor',
  'How’s my streak doing?',
  'Start a 25-minute focus session',
];

interface AssistantChatProps {
  compact?: boolean;
  /** For surfaces that open on demand — the dashboard dock, not the popup */
  autoFocus?: boolean;
  surface?: 'embedded' | 'dashboard' | 'sidepanel';
  /** Quiet orientation copy supplied by the surface that owns the assistant. */
  contextLabel?: string;
}

/**
 * Keep the enabled/disabled branch outside the hook-heavy chat. Settings load
 * asynchronously: returning early halfway through the chat made its first
 * render call fewer hooks than its second, crashing React with error #310.
 */
export function AssistantChat(props: AssistantChatProps) {
  const [storedSettings, loaded] = useStorageValue('settings');
  if (!loaded) return <p className="as-hint">Preparing assistant…</p>;

  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };
  if (!settings.assistantEnabled) {
    return <p className="as-hint">The assistant is turned off — enable it in Settings.</p>;
  }
  return <EnabledAssistantChat {...props} settings={settings} />;
}

function EnabledAssistantChat({
  compact = false,
  autoFocus = false,
  surface = 'embedded',
  contextLabel,
  settings,
}: AssistantChatProps & { settings: Settings }) {
  const [thread] = useSessionValue('assistantThread');
  const ai = useBrainDumpAI();

  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState<string | null>(null);
  const [phase, setPhase] = useState<AssistantPhase | null>(null);
  // What the ReAct loop is doing right now. Replaced by the persisted trace on
  // the finished turn, so the list does not jump when the answer lands.
  const [liveTrace, setLiveTrace] = useState<TraceStep[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const nanoUsable = ai.availability === 'available' || ai.availability === 'downloadable';
  const cloudReady = hasCloudKey(settings);
  const usable = nanoUsable || cloudReady;

  // Settings arrive a tick after mount, so the input is disabled — and unable to
  // take focus — on the first render. Focus when it can actually accept it.
  useEffect(() => {
    if (autoFocus && usable) inputRef.current?.focus();
  }, [autoFocus, usable]);

  const speech = useSpeechInput({
    onFinal: (transcript) => void send(transcript),
    onInterim: setText,
    // Browsers without the Web Speech API transcribe with Gemini instead
    hasGeminiKey: settings.geminiApiKey.length > 0,
  });

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    // A list of results is read from the top — landing on the last card would
    // hide the best-ranked one above the fold. Replies still land at the end.
    log.scrollTo({ top: log.scrollHeight });
  }, [thread, partial]);

  const say = (reply: string) => {
    if (settings.assistantVoiceEnabled) speak(reply, settings.assistantTtsVoice);
  };

  const send = async (raw?: string) => {
    const input = (raw ?? text).trim();
    if (!input || busy) return;
    cancelSpeech();
    setText('');
    setBusy(true);

    const prior = thread;
    const toolsPromise = getActiveTools();
    await persistTurn(newTurn('user', input));

    try {
      const outcome = await runAssistantTurn(input, prior, {
        nano: nanoProvider,
        cloud: cloudProviderFor(settings),
        // Only connected integrations, so Jarvis can't offer to archive mail
        // or block time on a calendar this install has never signed into
        tools: await toolsPromise,
        onToken: setPartial,
        onPhase: setPhase,
        cache: true,
        react: settings.assistantReactEnabled,
        preferCloudForAnswers: true,
        availability: {
          nano: nanoUsable,
          cloud: cloudReady,
          gemini: settings.geminiApiKey.trim() !== '',
          anthropic: settings.anthropicApiKey.trim() !== '',
        },
        onStep: (step) =>
          setLiveTrace((steps) => {
            const at = steps.findIndex((s) => s.n === step.n);
            if (at === -1) return [...steps, step];
            const next = [...steps];
            next[at] = step;
            return next;
          }),
      });
      void ai.refresh();
      await persistOutcome(outcome, say);
    } catch {
      await persistTurn(
        newTurn('assistant', 'Something went wrong. Try again?', { kind: 'error', source: 'local' }),
      );
    } finally {
      setPartial(null);
      setPhase(null);
      setLiveTrace([]);
      setBusy(false);
    }
  };

  const sendRef = useRef(send);
  sendRef.current = send;

  const confirm = async (turn: AssistantTurn) => {
    if (!turn.toolCall || busy) return;
    setBusy(true);
    try {
      const { text } = await executeTool(turn.toolCall.name, turn.toolCall.params);
      await patchTurn(turn.id, { toolCall: { ...turn.toolCall, status: 'done' } });
      await persistTurn(
        newTurn('assistant', text, { kind: 'action-result', source: 'local' }),
      );
      say(text);
    } catch (err) {
      await patchTurn(turn.id, { toolCall: { ...turn.toolCall, status: 'failed' } });
      await persistTurn(
        newTurn('assistant', err instanceof Error ? err.message : 'That action failed.', {
          kind: 'error',
          source: 'local',
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const cancel = (turn: AssistantTurn) => {
    if (turn.plan) {
      void patchTurn(turn.id, { plan: { ...turn.plan, status: 'cancelled' } });
      return;
    }
    if (!turn.toolCall) return;
    void patchTurn(turn.id, { toolCall: { ...turn.toolCall, status: 'cancelled' } });
  };

  const confirmPlan = async (turn: AssistantTurn) => {
    if (!turn.plan || busy) return;
    setBusy(true);
    const steps: AssistantPlanStep[] = turn.plan.steps.map((s) => ({ ...s }));
    try {
      // Confirmed plans apply atomically in the SW (single writer, run lock) —
      // a parallel agent run can't interleave with these steps
      const run = await sendMessage({
        type: 'AGENT_APPLY_PROPOSALS',
        proposals: steps.map((s) => ({ tool: s.name, params: s.params, summary: s.summary })),
      });
      run.outcomes.forEach((outcome, i) => {
        if (steps[i]) steps[i] = { ...steps[i], status: outcome.status };
      });
      await patchTurn(turn.id, { plan: { steps, status: run.ok ? 'done' : 'failed' } });
      await persistTurn(newTurn('assistant', run.text, { kind: 'action-result', source: 'local' }));
      say(run.ok ? `Done — all ${steps.length} steps completed.` : 'I hit a snag partway through.');
    } catch (err) {
      await patchTurn(turn.id, { plan: { steps, status: 'failed' } });
      await persistTurn(
        newTurn('assistant', err instanceof Error ? err.message : 'That plan failed.', {
          kind: 'error',
          source: 'local',
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`as-chat${compact ? ' compact' : ''} as-chat--${surface}`}>
      {contextLabel && <p className="as-context">{contextLabel}</p>}
      <div className="as-log" ref={logRef}>
        {thread.length === 0 && partial === null && !usable && (
          // An inert input with greyed-out suggestions is the state this
          // replaces: in Brave there is no Nano to wait for, so nothing would
          // ever have enabled it, and nothing said so.
          <div className="as-empty">
            <p className="as-empty-title">The assistant needs a model</p>
            <p className="as-hint">
              Add a Gemini or Anthropic API key to use the assistant. Chrome can also run
              Google’s built-in Nano model on-device where it is available; Brave and other
              Chromium browsers do not ship it.
            </p>
            <button
              type="button"
              className="as-suggestion"
              onClick={() => void chrome.runtime.openOptionsPage()}
            >
              Open Settings → Assistant
            </button>
          </div>
        )}
        {thread.length === 0 && partial === null && usable && (
          <div className="as-empty">
            <p className="as-empty-title">What would you like to accomplish?</p>
            <p className="as-hint">Ask about your day or give the assistant something to do.</p>
            <div className="as-suggestions">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className="as-suggestion"
                disabled={busy}
                onClick={() => void send(s)}
              >
                {s}
              </button>
            ))}
            </div>
          </div>
        )}
        {thread.map((turn) => (
          <Bubble
            key={turn.id}
            turn={turn}
            onConfirm={confirm}
            onConfirmPlan={confirmPlan}
            onCancel={cancel}
            busy={busy}
          />
        ))}
        {(partial !== null || busy) && (
          <div className="as-bubble assistant streaming">
            <Trace steps={liveTrace} live />
            {partial || (
              <span className="as-thinking">
                {phase === 'routing'
                  ? 'Understanding…'
                  : phase === 'retrieving'
                    ? 'Checking your data…'
                    : phase === 'verifying'
                      ? 'Checking the answer…'
                      : phase === 'generating'
                        ? 'Writing…'
                        : '…'}
              </span>
            )}
          </div>
        )}
      </div>

      {ai.checked && !usable && (
        <p className="as-hint">
          On-device AI isn’t available in this browser — add a Gemini API key in Settings →
          Assistant to chat via the cloud.
        </p>
      )}
      {ai.availability === 'downloadable' && (
        <p className="as-hint">First use downloads the browser’s on-device model (one time).</p>
      )}
      {speech.denied && (
        <p className="as-hint">
          Microphone is blocked — grant it from Settings → Assistant, then reload.
        </p>
      )}
      {!speech.supported && speech.reason && usable && (
        <p className="as-hint">{speech.reason}</p>
      )}

      <form
        className="as-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={inputRef}
          className="as-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          aria-label="Message Assistant"
          placeholder="Message Assistant"
          maxLength={1000}
          disabled={busy || !usable}
        />
        {speech.supported && usable && (
          <button
            type="button"
            className={speech.listening ? 'as-mic listening' : 'as-mic'}
            aria-label={speech.listening ? 'Release to stop listening' : 'Hold to talk'}
            title={speech.cloud ? 'Hold to talk (audio is sent to Gemini)' : 'Hold to talk'}
            disabled={busy || speech.transcribing}
            onPointerDown={(e) => {
              e.preventDefault();
              cancelSpeech();
              speech.start();
            }}
            onPointerUp={speech.stop}
            onPointerLeave={speech.stop}
          >
            {speech.transcribing ? (
              <span className="as-mic-progress">…</span>
            ) : (
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M12 15.25a3.75 3.75 0 0 0 3.75-3.75V6a3.75 3.75 0 0 0-7.5 0v5.5A3.75 3.75 0 0 0 12 15.25Z" />
                <path d="M5.75 11.25a6.25 6.25 0 0 0 12.5 0M12 17.5V21M9 21h6" />
              </svg>
            )}
          </button>
        )}
        <button
          type="submit"
          className="as-send"
          aria-label="Send message"
          disabled={busy || !usable || !text.trim()}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" />
          </svg>
        </button>
        <details className="as-more">
          <summary aria-label="Assistant options" title="Assistant options">
            •••
          </summary>
          <div className="as-more-menu">
            <button
              type="button"
              onClick={() => {
                if (settings.assistantVoiceEnabled) cancelSpeech();
                void patchSettings({ assistantVoiceEnabled: !settings.assistantVoiceEnabled });
              }}
            >
              {settings.assistantVoiceEnabled ? 'Turn spoken replies off' : 'Speak replies aloud'}
            </button>
            {thread.length > 0 && (
              <button type="button" onClick={() => void setSession({ assistantThread: [] })}>
                Clear conversation
              </button>
            )}
          </div>
        </details>
      </form>
    </div>
  );
}

function traceIcon(status: TraceStep['status']): string {
  if (status === 'done') return '✓';
  if (status === 'failed') return '✗';
  if (status === 'staged') return '⏸';
  if (status === 'skipped') return '–';
  return '·';
}

/**
 * What the assistant is doing, or did. Live while the turn runs; collapsed
 * under the answer afterwards, so the work is auditable without the trace
 * competing with the reply for attention.
 */
/**
 * How the answer was reached: which route, which model, whether it came from
 * cache, how much evidence it had, how long it took.
 *
 * The guardrails around the loop — budgets, the critic pass, fail-closed tool
 * classification — are only trustworthy if you can see them work. This is the
 * cheapest possible way to make that checkable: the data was already captured
 * on every turn and simply never rendered. Content-free by construction, so it
 * costs no privacy to show.
 */
function Diagnostics({ d }: { d: NonNullable<AssistantTurn['diagnostics']> }) {
  const parts = [
    d.route,
    d.provider,
    d.cacheHit ? 'cached' : null,
    d.evidenceCount > 0 ? `${d.evidenceCount} source${d.evidenceCount === 1 ? '' : 's'}` : null,
    `${(d.durationMs / 1000).toFixed(1)}s`,
    d.firstTokenMs !== undefined ? `first token ${(d.firstTokenMs / 1000).toFixed(1)}s` : null,
  ].filter(Boolean);
  return <p className="as-diagnostics">{parts.join(' · ')}</p>;
}

function Trace({
  steps,
  live,
  diagnostics,
}: {
  steps: TraceStep[];
  live?: boolean;
  diagnostics?: AssistantTurn['diagnostics'];
}) {
  if (steps.length === 0) return null;
  const list = (
    <ul className="as-trace">
      {steps.map((step) => (
        <li key={step.n} className={`as-trace-step ${step.status}`}>
          <span className="as-trace-icon">{traceIcon(step.status)}</span> {step.label}
          {step.detail && <span className="as-trace-detail"> — {step.detail}</span>}
        </li>
      ))}
    </ul>
  );
  if (live) return list;
  return (
    <details className="as-trace-wrap">
      <summary>
        Worked through {steps.length} step{steps.length === 1 ? '' : 's'}
      </summary>
      {list}
      {diagnostics && <Diagnostics d={diagnostics} />}
    </details>
  );
}

function Sources({ sources }: { sources: SourceRef[] }) {
  if (sources.length === 0) return null;
  return (
    <details className="as-sources">
      <summary>
        {sources.length} source{sources.length === 1 ? '' : 's'} checked
      </summary>
      <ul>
        {sources.map((source) => (
          <li key={source.id}>
            {source.url ? (
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.title}
              </a>
            ) : (
              <span>{source.title}</span>
            )}
            {source.snippet && <small>{source.snippet}</small>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function planStepIcon(step: AssistantPlanStep, index: number): string {
  if (step.status === 'done') return '✓';
  if (step.status === 'failed') return '✗';
  if (step.status === 'skipped') return '–';
  return `${index + 1}.`;
}

function Bubble({
  turn,
  onConfirm,
  onConfirmPlan,
  onCancel,
  busy,
}: {
  turn: AssistantTurn;
  onConfirm: (turn: AssistantTurn) => void;
  onConfirmPlan: (turn: AssistantTurn) => void;
  onCancel: (turn: AssistantTurn) => void;
  busy: boolean;
}) {
  // Model prose gets Markdown + LaTeX. Tool outputs and errors are our own one
  // line of text, and their bubbles put "✓ " inline in front of it — a block
  // renderer would break that onto its own line for nothing.
  const prose =
    turn.role === 'assistant' && turn.kind !== 'action-result' && turn.kind !== 'error';
  const cls =
    turn.role === 'user'
      ? 'as-bubble user'
      : turn.kind === 'error'
        ? 'as-bubble assistant error'
        : turn.kind === 'action-result'
          ? 'as-bubble assistant action'
          : 'as-bubble assistant';

  return (
    <div className={cls}>
      {turn.kind === 'action-result' && '✓ '}
      {prose ? (
        <Markdown text={turn.text} />
      ) : (
        turn.text
      )}
      {turn.sources?.length ? <Sources sources={turn.sources} /> : null}
      {turn.trace && <Trace steps={turn.trace} diagnostics={turn.diagnostics} />}
      {!turn.trace?.length && turn.diagnostics && (
        <details className="as-trace-wrap">
          <summary>How I got this</summary>
          <Diagnostics d={turn.diagnostics} />
        </details>
      )}
      {turn.grounding === 'insufficient' && <span className="as-badge">limited evidence</span>}
      {turn.source === 'cloud' && <span className="as-badge">cloud</span>}
      {turn.plan && (
        <ul className="as-plan">
          {turn.plan.steps.map((step, i) => (
            <li key={i} className={`as-plan-step ${step.status}`}>
              <span className="as-plan-icon">{planStepIcon(step, i)}</span> {step.summary}
            </li>
          ))}
        </ul>
      )}
      {turn.plan?.status === 'pending-confirm' && (
        <div className="as-confirm">
          <button className="as-confirm-yes" disabled={busy} onClick={() => onConfirmPlan(turn)}>
            ✓ Do all {turn.plan.steps.length}
          </button>
          <button className="as-confirm-no" disabled={busy} onClick={() => onCancel(turn)}>
            Cancel
          </button>
        </div>
      )}
      {turn.toolCall?.status === 'pending-confirm' && (
        <div className="as-confirm">
          <button className="as-confirm-yes" disabled={busy} onClick={() => onConfirm(turn)}>
            ✓ Do it
          </button>
          <button className="as-confirm-no" disabled={busy} onClick={() => onCancel(turn)}>
            Cancel
          </button>
        </div>
      )}
      {(turn.toolCall?.status === 'cancelled' || turn.plan?.status === 'cancelled') && (
        <span className="as-badge">cancelled</span>
      )}
      {(turn.toolCall?.status === 'failed' || turn.plan?.status === 'failed') && (
        <span className="as-badge">failed</span>
      )}
    </div>
  );
}
