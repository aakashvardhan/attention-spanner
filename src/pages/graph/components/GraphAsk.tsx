import { useEffect, useRef, useState } from 'react';
import { runAssistantTurn } from '../../../shared/ai/assistant';
import { cloudProviderFor } from '../../../shared/ai/cloud';
import { getActiveTools } from '../../../shared/ai/connector';
import { executeTool } from '../../../shared/ai/assistant';
import { nanoProvider } from '../../../shared/ai/nanoProvider';
import { Markdown } from '../../../shared/components/Markdown';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { DEFAULT_SETTINGS } from '../../../shared/storage';
import '../../../shared/components/assistant.css';

/**
 * Asking about the graph, on the graph.
 *
 * Deliberately not `AssistantChat`: that component carries a wake-word claim,
 * text-to-speech, speech input, paper cards, plan confirmation and the
 * persistent session thread — all wrong over a full-bleed canvas, and mounting
 * it here would add a second racing claimer for the pending wake command, which
 * its own comment says is deliberately raced. `AskPanel` in the reader is the
 * established precedent for a small chat that is not AssistantChat, and this
 * follows it: local turns, the shared `as-*` bubble styles, one input.
 *
 * The graph tools arrive through `getActiveTools()` like any other, so nothing
 * here knows what focus_graph or explain_cluster do.
 */

interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

const SUGGESTIONS = [
  '“Show me just the diffusion papers”',
  '“What is on screen right now?”',
  '“What have I not read here?”',
];

interface Props {
  /** Controlled by the page: the canvas has to keep its fit clear of this. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function GraphAsk({ open, onOpenChange }: Props) {
  const [storedSettings] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState<string | null>(null);
  /** A mutating tool the assistant wants permission for. */
  const [confirm, setConfirm] = useState<
    { toolName: string; params: Record<string, unknown>; summary: string } | null
  >(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns, partial, open]);

  const push = (turn: Turn) => setTurns((prev) => [...prev, turn]);

  async function send(raw?: string) {
    const question = (raw ?? input).trim();
    if (!question || busy) return;
    setInput('');
    setConfirm(null);
    setBusy(true);
    push({ role: 'user', text: question });

    try {
      const outcome = await runAssistantTurn(question, [], {
        nano: nanoProvider,
        cloud: cloudProviderFor(settings),
        tools: await getActiveTools(),
        onToken: setPartial,
        react: settings.assistantReactEnabled,
        cache: true,
      });

      if (outcome.kind === 'confirm') {
        setConfirm({
          toolName: outcome.toolName,
          params: outcome.params,
          summary: outcome.summary,
        });
        push({ role: 'assistant', text: outcome.summary });
      } else if (outcome.kind === 'confirm-plan') {
        // A multi-step plan needs the dock's proposal UI to be applied safely,
        // so say what it is rather than half-offering it here.
        push({ role: 'assistant', text: `${outcome.summary}\n\nRun that from the assistant panel.` });
      } else {
        push({ role: 'assistant', text: outcome.text });
      }
    } catch (err) {
      push({ role: 'assistant', text: (err as Error).message || 'Something went wrong. Try again?' });
    } finally {
      setPartial(null);
      setBusy(false);
    }
  }

  async function runConfirmed() {
    if (!confirm) return;
    const pending = confirm;
    setConfirm(null);
    setBusy(true);
    try {
      const result = await executeTool(pending.toolName, pending.params);
      push({ role: 'assistant', text: typeof result === 'string' ? result : result.text });
    } catch (err) {
      push({ role: 'assistant', text: (err as Error).message || 'That did not work.' });
    } finally {
      setBusy(false);
    }
  }

  if (!settings.assistantEnabled) return null;

  if (!open) {
    return (
      <button className="gr-ask-open" onClick={() => onOpenChange(true)}>
        Ask about this graph
      </button>
    );
  }

  return (
    <aside className="gr-ask" aria-label="Ask about the graph">
      <div className="gr-ask-head">
        <h2>Ask</h2>
        <button className="ghost-btn" onClick={() => onOpenChange(false)} aria-label="Close ask">
          ✕
        </button>
      </div>

      <div className="as-chat">
        <div className="as-log" ref={logRef}>
          {turns.length === 0 && partial === null && (
            <div className="as-empty">
              <p className="as-hint">Ask about what you are looking at:</p>
              {SUGGESTIONS.map((s) => (
                <p key={s} className="as-suggestion">
                  {s}
                </p>
              ))}
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={t.role === 'user' ? 'as-bubble user' : 'as-bubble assistant'}>
              {t.role === 'assistant' ? <Markdown text={t.text} /> : t.text}
            </div>
          ))}
          {partial !== null && (
            <div className="as-bubble assistant streaming">
              {partial || <span className="as-thinking">…</span>}
            </div>
          )}
          {busy && partial === null && (
            <div className="as-bubble assistant streaming as-thinking">…</div>
          )}
          {confirm && (
            <div className="as-confirm">
              <button className="as-confirm-yes" onClick={() => void runConfirmed()}>
                Do it
              </button>
              <button className="as-confirm-no" onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </div>
          )}
        </div>

        <form
          className="as-input-row"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            type="text"
            className="as-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about the graph…"
            maxLength={1000}
            disabled={busy}
          />
          <button type="submit" className="as-send" disabled={busy || !input.trim()}>
            ↑
          </button>
        </form>
      </div>
    </aside>
  );
}
