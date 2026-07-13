/**
 * Text-to-speech for assistant replies via speechSynthesis (built into
 * Chrome, works in extension pages, no permission needed).
 */

/** Strip markdown-ish syntax and emoji-only noise so TTS reads naturally */
export function ttsCleanText(text: string): string {
  return text
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
