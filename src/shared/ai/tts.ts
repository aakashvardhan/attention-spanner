/**
 * Text-to-speech for assistant replies via speechSynthesis (built into
 * Chrome, works in extension pages, no permission needed).
 */

/** Remove emoji/pictographs — assistant output is text-only by design */
export function stripEmoji(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}️‍]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,!?;:])/g, '$1')
    .trim();
}

/** Strip markdown-ish syntax and emoji so TTS reads naturally */
export function ttsCleanText(text: string): string {
  return stripEmoji(text)
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/[*_`#>|]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function speak(text: string, voiceName = '', onEnd?: () => void): void {
  if (typeof speechSynthesis === 'undefined') {
    onEnd?.();
    return;
  }
  const clean = ttsCleanText(text);
  if (!clean) {
    onEnd?.();
    return;
  }
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.rate = 1.05;
  if (voiceName) {
    const voice = speechSynthesis.getVoices().find((v) => v.name === voiceName);
    if (voice) utterance.voice = voice;
  }
  if (onEnd) {
    utterance.onend = onEnd;
    utterance.onerror = onEnd; // cancel() surfaces as an error event
  }
  speechSynthesis.speak(utterance);
}

export function cancelSpeech(): void {
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}

/** Shortest sentence worth speaking early (avoids reading "1." fragments) */
const MIN_SPEAK_CHUNK_CHARS = 25;

/**
 * Pure chunking step for streamed TTS: find the last complete sentence
 * boundary in the not-yet-spoken text. Returns null until enough complete
 * sentences have accumulated.
 */
export function extractSpeakableChunk(
  unspoken: string,
  minChars = MIN_SPEAK_CHUNK_CHARS,
): { chunk: string; consumed: number } | null {
  const boundary = /[.!?…]["”’')\]]?(?=\s|$)/g;
  let lastEnd = -1;
  for (let m = boundary.exec(unspoken); m !== null; m = boundary.exec(unspoken)) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < minChars) return null;
  return { chunk: unspoken.slice(0, lastEnd), consumed: lastEnd };
}

export interface SentenceSpeaker {
  /** Feed the accumulated streamed text; speaks completed sentences early */
  push(accumulated: string): void;
  /** Speak whatever remains of the final text; resolves when audio finishes */
  finish(finalText: string): Promise<void>;
  cancel(): void;
  /** Whether any utterance has been queued yet */
  spoke(): boolean;
}

/**
 * Speaks a streamed reply sentence-by-sentence: utterances are queued on
 * speechSynthesis WITHOUT cancel(), so the native queue preserves order and
 * each sentence starts the moment the previous one ends. `onFirstUtterance`
 * fires just before the first sentence plays — the wake listener uses it to
 * cut the mic exactly when audio is about to start (self-hearing guard).
 */
export function createSentenceSpeaker(
  voiceName: string,
  onFirstUtterance?: () => void,
): SentenceSpeaker {
  let spokenChars = 0;
  let lastAccumulated = '';
  let outstanding = 0;
  let started = false;
  let cancelled = false;
  let finished = false;
  let resolveDone: (() => void) | null = null;

  const maybeResolve = () => {
    if (finished && outstanding === 0) resolveDone?.();
  };

  const speakChunk = (chunk: string) => {
    if (cancelled) return;
    const clean = ttsCleanText(chunk);
    if (!clean) return;
    if (!started) {
      started = true;
      onFirstUtterance?.();
    }
    if (typeof speechSynthesis === 'undefined') return;
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = 1.05;
    if (voiceName) {
      const voice = speechSynthesis.getVoices().find((v) => v.name === voiceName);
      if (voice) utterance.voice = voice;
    }
    outstanding += 1;
    // onerror included in the drain count — a stalled queue must never
    // leave the wake listener stuck in 'speaking'
    utterance.onend = utterance.onerror = () => {
      outstanding -= 1;
      maybeResolve();
    };
    speechSynthesis.speak(utterance);
  };

  return {
    push(accumulated: string): void {
      if (cancelled || finished) return;
      lastAccumulated = accumulated;
      const next = extractSpeakableChunk(accumulated.slice(spokenChars));
      if (!next) return;
      spokenChars += next.consumed;
      speakChunk(next.chunk);
    },
    finish(finalText: string): Promise<void> {
      if (cancelled) return Promise.resolve();
      finished = true;
      // The cursor lives in raw streamed-text space; finalText may be a
      // cleaned (emoji-stripped/trimmed) variant, so prefer our own raw
      // accumulation when it is the longer authority.
      const full = lastAccumulated.length >= finalText.length ? lastAccumulated : finalText;
      speakChunk(full.slice(spokenChars));
      spokenChars = full.length;
      if (outstanding === 0) return Promise.resolve();
      return new Promise((resolve) => {
        resolveDone = resolve;
        maybeResolve();
      });
    },
    cancel(): void {
      cancelled = true;
      finished = true;
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
      resolveDone?.();
    },
    spoke: () => started,
  };
}

/** getVoices() is empty until voiceschanged on a fresh page — await it once */
export function listVoices(): Promise<SpeechSynthesisVoice[]> {
  if (typeof speechSynthesis === 'undefined') return Promise.resolve([]);
  const now = speechSynthesis.getVoices();
  if (now.length > 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
    speechSynthesis.addEventListener(
      'voiceschanged',
      () => {
        clearTimeout(timer);
        resolve(speechSynthesis.getVoices());
      },
      { once: true },
    );
  });
}
