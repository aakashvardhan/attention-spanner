/**
 * Speaking from the service worker via chrome.tts.
 *
 * The offscreen document cannot speak for itself. speechSynthesis there is
 * rejected by Chrome's autoplay policy with 'not-allowed' — an offscreen
 * document never receives user activation, and nothing can give it any — so
 * every spoken wake-word reply was silent. chrome.tts is not gated on
 * activation, but offscreen documents only get chrome.runtime, so the call has
 * to happen here and the offscreen listener asks for it by message.
 */

/** Utterances outlive the worker; never leave the caller waiting on a dead one */
const SPEAK_TIMEOUT_MS = 60_000;

/**
 * Speak one utterance. Resolves when it stops being audible, however it stops —
 * the wake listener holds its microphone closed until then, so a rejected or
 * interrupted utterance must settle just like a finished one.
 */
export function speakViaTts(text: string, voiceName: string, enqueue: boolean): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, SPEAK_TIMEOUT_MS);
    chrome.tts.speak(
      text,
      {
        // An unknown name falls back to the system default rather than failing
        ...(voiceName ? { voiceName } : {}),
        rate: 1.05,
        enqueue,
        onEvent: (event) => {
          if (event.type === 'end' || event.type === 'error' || event.type === 'interrupted') {
            done();
          }
        },
      },
      () => {
        if (chrome.runtime.lastError) done();
      },
    );
  });
}

export function stopTts(): void {
  chrome.tts.stop();
}
