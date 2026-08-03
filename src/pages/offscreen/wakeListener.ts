import { runAssistantTurn } from '../../shared/ai/assistant';
import type { AssistantProvider } from '../../shared/ai/assistantTypes';
import { newTurn } from '../../shared/ai/assistantTypes';
import { getAvailability } from '../../shared/ai/brainDump';
import { getActiveTools } from '../../shared/ai/connector';
import { geminiProvider } from '../../shared/ai/geminiProvider';
import { nanoProvider } from '../../shared/ai/nanoProvider';
import { createCloudStt } from '../../shared/ai/cloudStt';
import { createWebSpeechStt } from '../../shared/ai/webSpeechStt';
import type { SttEngine } from '../../shared/ai/stt';
import {
  createSentenceSpeaker,
  ttsCleanText,
  type SentenceSpeaker,
  type SpeechBackend,
} from '../../shared/ai/tts';
import { detectCapabilities } from '../../shared/capabilities';
import {
  REACT_WAKE_DEADLINE_MS,
  WAKE_ACK_TIMEOUT_MS,
  WAKE_CAPTURE_MAX_MS,
  WAKE_CAPTURE_SILENCE_MS,
  WAKE_MIC_RETRY_MS,
  WAKE_PTT_FAILSAFE_MS,
} from '../../shared/constants';
import { sendMessage } from '../../shared/messages';
import { getSettings, setSession } from '../../shared/storage';
import type { Settings } from '../../shared/types';
import { pickWakeSource, type WakeSource } from './wakeSource';

/**
 * Always-on "Hey Jarvis".
 *
 * listening → (wake word) → capturing → (silence) → thinking → speaking → listening
 *
 * Two capabilities, chosen per browser and kept apart on purpose, because they
 * used to be one object and that is why this feature did not exist in Brave:
 *
 *   noticing the word  → WakeSource  (on-device ONNX, or the browser's recognizer)
 *   transcribing after → SttEngine   (the browser's recognizer, or Gemini)
 *
 * Splitting them is what makes the wake word portable. Detection runs locally
 * wherever WebAssembly does, so the microphone is no longer a continuous feed
 * to a speech service just to notice one word, and only the command spoken
 * *after* the wake word is ever transcribed.
 *
 * The microphone is held by exactly one of them at a time. The source releases
 * it before capture begins and takes it back afterwards — two getUserMedia
 * sessions on one device conflict, which is the same reason the WAKE_MIC_BUSY
 * handshake exists for push-to-talk elsewhere.
 *
 * Nothing listens while TTS plays: Jarvis would hear himself. Speech goes out
 * through the service worker (TTS_SPEAK) rather than speechSynthesis — this
 * document has no user activation and never can, so the autoplay policy
 * rejects speaking here outright. See src/background/speech.ts.
 */

/** Speaks through the worker's chrome.tts; resolves when the audio has stopped */
function workerSpeech(voiceName: string): SpeechBackend {
  return {
    speak: async (text) => {
      await sendMessage({ type: 'TTS_SPEAK', text, voiceName, enqueue: true });
    },
    stop: () => void sendMessage({ type: 'TTS_STOP' }),
  };
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

/**
 * Availability + settings memos. Every read from here is a PROXY_STORAGE
 * round-trip to the SW, so we (a) cache for a minute and (b) prefetch the
 * moment the wake word fires — the hops overlap with the user still talking
 * and cost zero wall-clock by the time the command is processed.
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

/**
 * Transcriber for the command that follows the wake word. Prefers the
 * browser's own recognizer — free and streaming — and falls back to recording
 * plus Gemini where there isn't one. The cloud engine has to end itself on a
 * pause: nothing is held down here, unlike push-to-talk.
 */
function createCommandStt(): SttEngine {
  return detectCapabilities().webSpeech
    ? createWebSpeechStt()
    : createCloudStt({ autoStopSilenceMs: WAKE_CAPTURE_SILENCE_MS });
}

export class WakeListener {
  private state: WakeState = 'listening';
  private source: WakeSource | null = null;
  private stt: SttEngine | null = null;
  private command = '';
  /** Whether the current denial has already been reported */
  private micDenied = false;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private maxCaptureTimer: ReturnType<typeof setTimeout> | undefined;
  private failsafeTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  start(): void {
    void this.spinUp();
  }

  /**
   * Tear down for good — the wake word was switched off, or the document is
   * being handed to the recorder alone. Setting 'stopped' first is what stops
   * anything asynchronous from bringing the microphone back.
   */
  stop(): void {
    this.state = 'stopped';
    this.clearCaptureTimers();
    clearTimeout(this.failsafeTimer);
    clearTimeout(this.retryTimer);
    this.stt?.abort();
    this.stt = null;
    this.source?.stop();
    this.source = null;
  }

  /** Push-to-talk somewhere holds the mic — two sessions on one device conflict */
  setPaused(busy: boolean): void {
    if (this.state === 'stopped') return;
    clearTimeout(this.failsafeTimer);
    if (busy) {
      this.clearCaptureTimers();
      this.state = 'paused';
      this.stt?.abort();
      this.stt = null;
      this.source?.stop();
      this.source = null;
      // The holding page may close without sending busy:false — auto-resume
      this.failsafeTimer = setTimeout(() => this.setPaused(false), WAKE_PTT_FAILSAFE_MS);
    } else if (this.state === 'paused') {
      this.state = 'listening';
      void this.spinUp();
    }
  }

  /** Is the listener parked? Opaque to narrowing on purpose — see spinUp. */
  private settled(): boolean {
    return this.state === 'stopped' || this.state === 'paused';
  }

  /** Bring up a wake source and start listening for the word. */
  private async spinUp(): Promise<void> {
    if (this.source || this.state === 'stopped' || this.state === 'paused') return;
    const { source, reason } = await pickWakeSource();
    if (!source) {
      // The original failure mode was silence; say it out loud instead.
      console.error('[wake] cannot listen:', reason);
      this.state = 'stopped';
      return;
    }
    // stop() or setPaused() may have run while the models were loading. Read
    // through a call: TypeScript narrows `this.state` from the guard above and
    // would otherwise decide this re-check is dead code, which it is not — an
    // await sits between the two.
    if (this.settled()) {
      source.stop();
      return;
    }
    this.source = source;
    await source.start(
      (command) => this.onWake(command),
      (kind) => this.onSourceError(kind),
    );
  }

  private onSourceError(kind: 'denied' | 'other'): void {
    this.source?.stop();
    this.source = null;
    if (kind === 'denied') {
      if (!this.micDenied) {
        this.micDenied = true;
        console.error('[wake] microphone refused — retrying slowly until it is granted');
        void sendMessage({ type: 'WAKE_EVENT', event: 'mic-denied' });
      }
      this.retryAfter(WAKE_MIC_RETRY_MS);
      return;
    }
    console.warn('[wake] wake source failed; retrying');
    this.retryAfter(WAKE_MIC_RETRY_MS);
  }

  /** Park in 'backoff' and try to listen again after `ms` */
  private retryAfter(ms: number): void {
    if (this.state === 'stopped') return;
    this.state = 'backoff';
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.state !== 'backoff') return;
      this.state = 'listening';
      void this.spinUp();
    }, ms);
  }

  /**
   * The wake word was said. Hand the microphone from the source to the
   * transcriber and open a capture window.
   *
   * `command` is non-empty only from the Web Speech source, which can hear the
   * wake word and the request in one transcript. The on-device detector knows
   * nothing but that the word was said, so the command arrives from the STT
   * engine a moment later.
   */
  private onWake(command: string): void {
    if (this.state !== 'listening') return;
    this.micDenied = false; // the mic evidently works
    this.state = 'capturing';
    this.command = command;
    console.log('[wake] wake word detected');
    // Prefetch while the user is still talking — free by processing time
    void probeAvailability().catch(() => undefined);
    void memoizedSettings().catch(() => undefined);

    // The source must let go before the transcriber can take the device
    this.source?.stop();
    this.source = null;

    const stt = createCommandStt();
    this.stt = stt;
    stt.start({
      onInterim: () => this.armSilenceTimer(WAKE_CAPTURE_SILENCE_MS),
      onFinal: (text) => {
        this.command = `${this.command} ${text}`.trim();
      },
      onError: (kind) => {
        if (kind === 'denied') this.micDenied = true;
      },
      onEnd: () => {
        this.stt = null;
        if (this.state === 'capturing') this.finishCapture();
      },
    });

    // A command said in the same breath is already complete; otherwise wait for
    // the speaker to finish, with a hard cap for audio that never goes quiet.
    this.armSilenceTimer(command ? WAKE_CAPTURE_SILENCE_MS : WAKE_ACK_TIMEOUT_MS);
    this.maxCaptureTimer = setTimeout(() => this.stopCapture(), WAKE_CAPTURE_MAX_MS);
  }

  private armSilenceTimer(ms: number): void {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.stopCapture(), ms);
  }

  /** Ask the transcriber to finish; onEnd lands us in finishCapture */
  private stopCapture(): void {
    this.clearCaptureTimers();
    if (this.stt) this.stt.stop();
    else this.finishCapture();
  }

  private clearCaptureTimers(): void {
    clearTimeout(this.silenceTimer);
    clearTimeout(this.maxCaptureTimer);
  }

  private finishCapture(): void {
    this.clearCaptureTimers();
    const command = this.command.trim();
    this.command = '';
    if (!command) {
      // Nothing was said after the wake word — back to passive listening,
      // silently. An acknowledgement here would talk over a user who is
      // simply slow to start.
      this.resumeListening();
      return;
    }
    this.state = 'thinking';
    void this.runTurn(command);
  }

  private resumeListening(): void {
    if (this.state === 'paused' || this.state === 'stopped') return;
    this.state = 'listening';
    void this.spinUp();
  }

  /** Release the microphone. Jarvis must not hear himself, and the device has
   *  to be free for whichever source or engine takes it next. */
  private releaseMic(): void {
    this.stt?.abort();
    this.stt = null;
    this.source?.stop();
    this.source = null;
  }

  /** TTS self-trigger guard: mic off before speaking, back on only after */
  private speakThen(text: string, after: () => void): void {
    this.state = 'speaking';
    this.releaseMic();
    void memoizedSettings().then(async (settings) => {
      if (this.state !== 'speaking') return; // paused/stopped while fetching
      const clean = ttsCleanText(text);
      if (clean) {
        await sendMessage({
          type: 'TTS_SPEAK',
          text: clean,
          voiceName: settings.assistantTtsVoice,
          enqueue: false,
        });
      }
      after();
    });
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
        // Only connected integrations — the wake path used to offer all 34
        // tools, including Gmail and calendar this install never signed into.
        tools: await getActiveTools(),
        cache: true,
        react: settings.assistantReactEnabled,
        // Nobody waits a minute for a spoken reply
        deadlineMs: REACT_WAKE_DEADLINE_MS,
        getPage: async () => (await sendMessage({ type: 'WAKE_GET_PAGE' })).page,
        onToken: (partial) => {
          // Speak completed sentences while the model is still generating —
          // first audio lands after the first sentence, not the full reply
          speakerRef.current ??= createSentenceSpeaker(workerSpeech(settings.assistantTtsVoice), () => {
            this.state = 'speaking';
            this.releaseMic();
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
