import { useEffect, useRef, useState } from 'react';
import { executeTool, runAssistantTurn } from '../ai/assistant';
import {
  appendTurn,
  newTurn,
  type AssistantTurn,
} from '../ai/assistantTypes';
import { geminiProvider } from '../ai/geminiProvider';
import { nanoProvider } from '../ai/nanoProvider';
import { cancelSpeech, speak } from '../ai/tts';
import { localDate } from '../format';
import { useBrainDumpAI } from '../hooks/useBrainDumpAI';
import { useSessionValue } from '../hooks/useSessionValue';
import { useSpeechInput } from '../hooks/useSpeechInput';
import { useStorageValue } from '../hooks/useStorageValue';
import { DEFAULT_SETTINGS, getSession, patchSettings, setSession } from '../storage';
import './assistant.css';

const SUGGESTIONS = [
  '“Add a task to email my advisor”',
  '“How’s my streak doing?”',
  '“Start a 25-minute focus session”',
];

/** Read-modify-write against the freshest session thread (avoids clobbering
 * a turn another surface appended while we were thinking). */
async function persistTurn(turn: AssistantTurn): Promise<void> {
  const { assistantThread } = await getSession('assistantThread');
  await setSession({ assistantThread: appendTurn(assistantThread, turn) });
}

async function patchTurn(id: string, patch: Partial<AssistantTurn>): Promise<void> {
  const { assistantThread } = await getSession('assistantThread');
  await setSession({
    assistantThread: assistantThread.map((t) =>
      t.id === id ? { ...t, ...patch, toolCall: patch.toolCall ?? t.toolCall } : t,
    ),
  });
}

export function AssistantChat({ compact = false }: { compact?: boolean }) {
  const [thread] = useSessionValue('assistantThread');
  const [storedSettings] = useStorageValue('settings');
  const [briefing] = useStorageValue('assistantBriefing');
  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };
  const ai = useBrainDumpAI();
  const todaysBriefing = briefing?.date === localDate() ? briefing.text : null;

  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const speech = useSpeechInput({
    onFinal: (transcript) => void send(transcript),
    onInterim: setText,
  });

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [thread, partial]);

  if (!settings.assistantEnabled) {
    return <p className="as-hint">The assistant is turned off — enable it in Settings.</p>;
  }

  const nanoUsable = ai.availability === 'available' || ai.availability === 'downloadable';
  const cloudReady = settings.geminiApiKey.trim() !== '';
  const usable = nanoUsable || cloudReady;

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
    await persistTurn(newTurn('user', input));

    try {
      const outcome = await runAssistantTurn(input, prior, {
        nano: nanoProvider,
        cloud: geminiProvider,
        onToken: setPartial,
      });
      void ai.refresh();
      if (outcome.kind === 'reply') {
        await persistTurn(newTurn('assistant', outcome.text, { source: outcome.source }));
        say(outcome.text);
      } else if (outcome.kind === 'confirm') {
        await persistTurn(
          newTurn('assistant', outcome.summary, {
            source: 'nano',
            toolCall: { name: outcome.toolName, params: outcome.params, status: 'pending-confirm' },
          }),
        );
        say(`Should I ${outcome.summary}?`);
      } else if (outcome.kind === 'done') {
        await persistTurn(
          newTurn('assistant', outcome.text, { kind: 'action-result', source: 'nano' }),
        );
        say(outcome.text);
      } else {
        await persistTurn(newTurn('assistant', outcome.text, { kind: 'error', source: 'local' }));
      }
    } catch {
      await persistTurn(
        newTurn('assistant', 'Something went wrong. Try again?', { kind: 'error', source: 'local' }),
      );
    } finally {
      setPartial(null);
      setBusy(false);
    }
  };

  const confirm = async (turn: AssistantTurn) => {
    if (!turn.toolCall || busy) return;
    setBusy(true);
    try {
      const result = await executeTool(turn.toolCall.name, turn.toolCall.params);
      await patchTurn(turn.id, { toolCall: { ...turn.toolCall, status: 'done' } });
      await persistTurn(newTurn('assistant', result, { kind: 'action-result', source: 'local' }));
      say(result);
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
    if (!turn.toolCall) return;
    void patchTurn(turn.id, { toolCall: { ...turn.toolCall, status: 'cancelled' } });
  };

  return (
    <div className={compact ? 'as-chat compact' : 'as-chat'}>
      <div className="as-log" ref={logRef}>
        {todaysBriefing && !compact && (
          <div className="as-bubble assistant briefing">
            <span className="as-briefing-label">Today</span>
            {todaysBriefing}
          </div>
        )}
        {thread.length === 0 && partial === null && (
          <div className="as-empty">
            <p className="as-hint">Ask about your day or tell me what to do:</p>
            {SUGGESTIONS.map((s) => (
              <p key={s} className="as-suggestion">
                {s}
              </p>
            ))}
          </div>
        )}
        {thread.map((turn) => (
          <Bubble key={turn.id} turn={turn} onConfirm={confirm} onCancel={cancel} busy={busy} />
        ))}
        {partial !== null && (
          <div className="as-bubble assistant streaming">
            {partial || <span className="as-thinking">…</span>}
          </div>
        )}
        {busy && partial === null && <div className="as-bubble assistant streaming as-thinking">…</div>}
      </div>

      {ai.checked && !usable && (
        <p className="as-hint">
          On-device AI isn’t available in this Chrome — add a Gemini API key in Settings →
          Assistant to chat via the cloud.
        </p>
      )}
      {ai.availability === 'downloadable' && (
        <p className="as-hint">First use downloads Chrome’s on-device model (one time).</p>
      )}
      {speech.denied && (
        <p className="as-hint">
          Microphone is blocked — grant it from Settings → Assistant, then reload.
        </p>
      )}

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
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask or command…"
          maxLength={1000}
          disabled={busy || !usable}
        />
        {speech.supported && usable && (
          <button
            type="button"
            className={speech.listening ? 'as-mic listening' : 'as-mic'}
            title="Hold to talk"
            disabled={busy}
            onPointerDown={(e) => {
              e.preventDefault();
              cancelSpeech();
              speech.start();
            }}
            onPointerUp={speech.stop}
            onPointerLeave={speech.stop}
          >
            🎙
          </button>
        )}
        <button
          type="button"
          className={settings.assistantVoiceEnabled ? 'as-voice on' : 'as-voice'}
          title={settings.assistantVoiceEnabled ? 'Stop speaking replies' : 'Speak replies aloud'}
          onClick={() => {
            if (settings.assistantVoiceEnabled) cancelSpeech();
            void patchSettings({ assistantVoiceEnabled: !settings.assistantVoiceEnabled });
          }}
        >
          {settings.assistantVoiceEnabled ? '🔊' : '🔇'}
        </button>
        <button type="submit" className="as-send" disabled={busy || !usable || !text.trim()}>
          ↑
        </button>
        {thread.length > 0 && (
          <button
            type="button"
            className="as-clear"
            title="Clear conversation"
            onClick={() => void setSession({ assistantThread: [] })}
          >
            ✕
          </button>
        )}
      </form>
    </div>
  );
}

function Bubble({
  turn,
  onConfirm,
  onCancel,
  busy,
}: {
  turn: AssistantTurn;
  onConfirm: (turn: AssistantTurn) => void;
  onCancel: (turn: AssistantTurn) => void;
  busy: boolean;
}) {
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
      {turn.text}
      {turn.source === 'cloud' && <span className="as-badge">cloud</span>}
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
      {turn.toolCall?.status === 'cancelled' && <span className="as-badge">cancelled</span>}
      {turn.toolCall?.status === 'failed' && <span className="as-badge">failed</span>}
    </div>
  );
}
