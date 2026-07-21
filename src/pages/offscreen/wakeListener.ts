import { runAssistantTurn } from '../../shared/ai/assistant';
import type { AssistantProvider } from '../../shared/ai/assistantTypes';
import { newTurn } from '../../shared/ai/assistantTypes';
import { getAvailability } from '../../shared/ai/brainDump';
import { geminiProvider } from '../../shared/ai/geminiProvider';
import { nanoProvider } from '../../shared/ai/nanoProvider';
import { createSentenceSpeaker, speak, type SentenceSpeaker } from '../../shared/ai/tts';
import { matchWakeWord } from '../../shared/ai/wakeWord';
import {
  WAKE_ACK_TIMEOUT_MS,
  WAKE_CAPTURE_MAX_MS,
  WAKE_CAPTURE_SILENCE_MS,
  WAKE_PTT_FAILSAFE_MS,
} from '../../shared/constants';
import { sendMessage } from '../../shared/messages';
import { getSettings, setSession } from '../../shared/storage';
import type { Settings } from '../../shared/types';

/**
 * Always-on "Hey Jarvis" listener over webkitSpeechRecognition (same engine
 * as the push-to-talk hook, but restart-on-end instead of hold-to-talk).
 *
 * listening → (wake word) → capturing → (silence) → thinking → speaking → listening
 *
 * Recognition is never active while TTS plays — Jarvis would hear himself —
 * and pauses while a page's push-to-talk mic is held (WAKE_MIC_BUSY).
 */

/* SpeechRecognition isn't in TS's dom lib yet — minimal local typing
   (mirrors useSpeechInput.ts) */
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechResultEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechResultEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** No user activation here, so Nano's one-time model download can't start —
    only use it when the model is already on disk */
const offscreenNano: AssistantProvider = {
  ...nanoProvider,
  available: async () => (await getAvailability()) === 'available',
};

type WakeState =
  | 'listening'
  | 'capturing'
  | 'thinking'
  | 'speaking'
  | 'paused'
  | 'backoff'
  | 'stopped';

const BACKOFF_MS = [1000, 5000, 15_000, 60_000];

/**
 * Availability + settings memos. Every read from here is a PROXY_STORAGE
 * round-trip to the SW, so we (a) cache for a minute and (b) prefetch the
 * moment the wake word matches — the hops overlap with the user still
 * talking and cost zero wall-clock by the time the command is processed.
 */
const MEMO_TTL_MS = 60_000;

let availMemo: { at: number; nano: boolean; cloud: boolean } | null = null;
async function probeAvailability(): Promise<{ nano: boolean; cloud: boolean }> {
  if (availMemo && Date.now() - availMemo.at < MEMO_TTL_MS) return availMemo;
  const [nano, cloud] = await Promise.all([
    offscreenNano.available(),
    geminiProvider.available(),
  ]);
  availMemo = { at: Date.now(), nano, cloud };
  return availMemo;
}

let settingsMemo: { at: number; value: Settings } | null = null;
async function memoizedSettings(): Promise<Settings> {
  if (settingsMemo && Date.now() - settingsMemo.at < MEMO_TTL_MS) return settingsMemo.value;
  const value = await getSettings();
  settingsMemo = { at: Date.now(), value };
  return value;
}

export class WakeListener {
  private state: WakeState = 'listening';
  private rec: SpeechRecognitionLike | null = null;
  private command = '';
  private errorCount = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private maxCaptureTimer: ReturnType<typeof setTimeout> | undefined;
  private failsafeTimer: ReturnType<typeof setTimeout> | undefined;
  private backoffTimer: ReturnType<typeof setTimeout> | undefined;

  start(): void {
    this.spinUp();
  }

  /** Push-to-talk somewhere holds the mic — two recognition sessions conflict */
  setPaused(busy: boolean): void {
    if (this.state === 'stopped') return;
    clearTimeout(this.failsafeTimer);
    if (busy) {
      this.clearCaptureTimers();
      this.state = 'paused';
      this.rec?.abort();
      // The holding page may close without sending busy:false — auto-resume
      this.failsafeTimer = setTimeout(() => this.setPaused(false), WAKE_PTT_FAILSAFE_MS);
    } else if (this.state === 'paused') {
      this.state = 'listening';
      this.spinUp();
    }
  }

  private spinUp(): void {
    const Ctor = recognitionCtor();
    if (!Ctor || this.rec) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = (e) => this.onResult(e);
    rec.onerror = (e) => this.onError(e.error);
    rec.onend = () => {
      this.rec = null;
      // Chrome drops continuous sessions periodically — keep the loop alive.
      // 'thinking' included: the recognizer stays warm through inference so
      // the next listening cycle skips the server STT reconnect.
      if (this.state === 'listening' || this.state === 'capturing' || this.state === 'thinking') {
        this.spinUp();
      }
    };
    try {
      rec.start();
      this.rec = rec;
    } catch {
      // start() throws if a session is already active — ignore
    }
  }

  private stopRecognition(): void {
    const rec = this.rec;
    this.rec = null;
    rec?.abort();
  }

  private clearCaptureTimers(): void {
    clearTimeout(this.silenceTimer);
    clearTimeout(this.maxCaptureTimer);
  }

  private onResult(e: SpeechResultEventLike): void {
    this.errorCount = 0; // hearing anything means the service is healthy
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      if (!result.isFinal) continue;
      const text = result[0].transcript.trim();
      if (!text) continue;

      if (this.state === 'listening') {
        const command = matchWakeWord(text);
        if (command === null) continue;
        this.state = 'capturing';
        this.command = command;
        // Prefetch while the user is still talking — free by processing time
        void probeAvailability().catch(() => undefined);
        void memoizedSettings().catch(() => undefined);
        this.maxCaptureTimer = setTimeout(() => this.finishCapture(), WAKE_CAPTURE_MAX_MS);
        if (command === '') {
          // Wake word alone — acknowledge, then hold the door open a bit longer
          this.speakThen('Yes?', () => {
            this.state = 'capturing';
            this.spinUp();
            this.armSilenceTimer(WAKE_ACK_TIMEOUT_MS);
          });
        } else {
          this.armSilenceTimer(WAKE_CAPTURE_SILENCE_MS);
        }
      } else if (this.state === 'capturing') {
        this.command = `${this.command} ${text}`.trim();
        this.armSilenceTimer(WAKE_CAPTURE_SILENCE_MS);
      }
    }
  }

  private armSilenceTimer(ms: number): void {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.finishCapture(), ms);
  }

  private finishCapture(): void {
    this.clearCaptureTimers();
    const command = this.command.trim();
    this.command = '';
    if (!command) {
      // "Yes?" went unanswered — back to passive listening
      this.state = 'listening';
      this.spinUp();
      return;
    }
    // Recognizer stays live through 'thinking' — onResult ignores results
    // outside listening/capturing, and the mic is cut the moment TTS starts
    // (speakThen / the sentence speaker's first utterance).
    this.state = 'thinking';
    void this.runTurn(command);
  }

  /** TTS self-trigger guard: mic off before speaking, back on only after */
  private speakThen(text: string, after: () => void): void {
    this.state = 'speaking';
    this.stopRecognition();
    void memoizedSettings().then((settings) => {
      if (this.state !== 'speaking') return; // paused/stopped while fetching
      speak(text, settings.assistantTtsVoice, after);
    });
  }

  private resumeListening(): void {
    if (this.state === 'paused' || this.state === 'stopped') return;
    this.state = 'listening';
    this.spinUp();
  }

  private onError(error: string): void {
    if (error === 'aborted') return; // our own stopRecognition/abort calls
    if (error === 'not-allowed' || error === 'service-not-allowed') {
      this.state = 'stopped';
      this.clearCaptureTimers();
      void sendMessage({ type: 'WAKE_EVENT', event: 'mic-denied' });
      return;
    }
    // network / no-speech / audio-capture: back off, then try again
    if (this.state !== 'listening' && this.state !== 'capturing') return;
    this.state = 'backoff';
    this.clearCaptureTimers();
    const delay = BACKOFF_MS[Math.min(this.errorCount, BACKOFF_MS.length - 1)];
    this.errorCount += 1;
    clearTimeout(this.backoffTimer);
    this.backoffTimer = setTimeout(() => {
      if (this.state !== 'backoff') return;
      this.state = 'listening';
      this.spinUp();
    }, delay);
  }

  /** Run the captured command through the assistant, mirroring AssistantChat.send */
  private async runTurn(command: string): Promise<void> {
    const resume = () => this.resumeListening();
    // Holder object: the speaker is created inside the onToken closure,
    // which TS's narrowing can't see through on a plain local
    const speakerRef: { current: SentenceSpeaker | null } = { current: null };
    try {
      // Both prefetched at capture start — usually memo hits by now
      const [{ nano: nanoOk, cloud: cloudOk }, settings] = await Promise.all([
        probeAvailability(),
        memoizedSettings(),
      ]);
      if (!nanoOk && !cloudOk) {
        // No model reachable from here — hand the raw command to the
        // dashboard, whose AssistantChat appends the user turn itself
        await setSession({ assistantPendingInput: command });
        await sendMessage({ type: 'WAKE_EVENT', event: 'handoff' });
        this.speakThen('Opening your dashboard.', resume);
        return;
      }

      // One round trip: append the user turn, get the prior thread back
      const { thread } = await sendMessage({
        type: 'ASSISTANT_BEGIN_TURN',
        turn: newTurn('user', command),
      });

      const outcome = await runAssistantTurn(command, thread, {
        nano: offscreenNano,
        cloud: geminiProvider,
        availability: { nano: nanoOk, cloud: cloudOk },
        cache: true,
        getPage: async () => (await sendMessage({ type: 'WAKE_GET_PAGE' })).page,
        onToken: (partial) => {
          // Speak completed sentences while the model is still generating —
          // first audio lands after the first sentence, not the full reply
          speakerRef.current ??= createSentenceSpeaker(settings.assistantTtsVoice, () => {
            this.state = 'speaking';
            this.stopRecognition();
          });
          speakerRef.current.push(partial);
        },
      });

      if (outcome.kind === 'reply' || outcome.kind === 'done') {
        const turn =
          outcome.kind === 'reply'
            ? newTurn('assistant', outcome.text, { source: outcome.source })
            : newTurn('assistant', outcome.text, { kind: 'action-result', source: 'nano' });
        await sendMessage({ type: 'ASSISTANT_APPEND_TURN', turn });
        await sendMessage({ type: 'WAKE_EVENT', event: 'replied', text: outcome.text });
        const speaker = speakerRef.current;
        if (speaker) {
          await speaker.finish(outcome.text);
          resume();
        } else {
          this.speakThen(outcome.text, resume);
        }
      } else if (outcome.kind === 'confirm') {
        await sendMessage({
          type: 'ASSISTANT_APPEND_TURN',
          turn: newTurn('assistant', outcome.summary, {
            source: 'nano',
            toolCall: { name: outcome.toolName, params: outcome.params, status: 'pending-confirm' },
          }),
        });
        await sendMessage({ type: 'WAKE_EVENT', event: 'needs-ui', text: `Confirm: ${outcome.summary}` });
        this.speakThen('I need a confirmation — check your dashboard.', resume);
      } else if (outcome.kind === 'confirm-plan') {
        await sendMessage({
          type: 'ASSISTANT_APPEND_TURN',
          turn: newTurn('assistant', `That's ${outcome.steps.length} steps:`, {
            source: 'cloud',
            plan: {
              steps: outcome.steps.map((s) => ({ ...s, status: 'pending' as const })),
              status: 'pending-confirm',
            },
          }),
        });
        await sendMessage({ type: 'WAKE_EVENT', event: 'needs-ui', text: outcome.summary });
        this.speakThen('That takes a few steps — confirm on your dashboard.', resume);
      } else {
        // Error outcome — a stream may have died mid-sentence; drop its queue
        speakerRef.current?.cancel();
        await sendMessage({
          type: 'ASSISTANT_APPEND_TURN',
          turn: newTurn('assistant', outcome.text, { kind: 'error', source: 'local' }),
        });
        this.speakThen(outcome.text, resume);
      }
    } catch {
      speakerRef.current?.cancel();
      await sendMessage({
        type: 'ASSISTANT_APPEND_TURN',
        turn: newTurn('assistant', 'Something went wrong. Try again.', {
          kind: 'error',
          source: 'local',
        }),
      }).catch(() => undefined);
      this.speakThen('Something went wrong.', resume);
    }
  }
}
