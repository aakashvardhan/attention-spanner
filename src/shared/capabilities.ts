/**
 * What the browser running this extension can actually do.
 *
 * Chromium is not one browser. Brave ships the same extension APIs but strips
 * the Google-backed web platform features behind them: `webkitSpeechRecognition`
 * is not present at all (not merely broken — the constructor is undefined), and
 * Gemini Nano's `LanguageModel` never existed outside Chrome. Both were assumed
 * present, so both failed to nothing: the wake listener returned at the top of
 * spinUp() and the mic button quietly declined to render.
 *
 * Everything here is feature detection. `isBrave` exists so the settings copy
 * can name the browser it is talking about — never to gate a feature. Gate on
 * the capability, because the next Chromium fork will make a different subset
 * of these choices and UA-shaped checks are how you end up back here.
 *
 * One non-copy use is permitted: resolving the cosmetic skin (theme.ts,
 * `resolveSkin`). That is not a gate — nothing is enabled or withheld by it,
 * and there is no capability to detect, because "which browser's palette"
 * is a preference rather than something the platform can answer. Anything
 * that changes what the extension can *do* still goes through the flags below.
 */

export interface Capabilities {
  /** Web Speech API. Chrome: yes. Brave: removed — it streams audio to Google. */
  webSpeech: boolean;
  /** Chrome's built-in on-device model (Gemini Nano). Chrome-only. */
  promptApi: boolean;
  /** speechSynthesis, how a page speaks an assistant reply aloud */
  speechSynthesis: boolean;
  /** Extension-page side panel */
  sidePanel: boolean;
  /** Labelling and the cosmetic skin only. Never gate a feature on this. */
  isBrave: boolean;
}

/**
 * Read the current context's globals. Context-dependent by design: offscreen
 * documents get a smaller `chrome` than pages do, and reporting what *this*
 * context can reach is the useful answer for the code asking.
 */
export function detectCapabilities(): Capabilities {
  const g = globalThis as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
    LanguageModel?: unknown;
    navigator?: { brave?: unknown };
  };
  return {
    webSpeech: g.SpeechRecognition !== undefined || g.webkitSpeechRecognition !== undefined,
    promptApi: g.LanguageModel !== undefined,
    speechSynthesis: typeof globalThis.speechSynthesis !== 'undefined',
    sidePanel: typeof chrome !== 'undefined' && typeof chrome.sidePanel?.open === 'function',
    // navigator.brave exists only in Brave; isBrave() is async and we do not
    // need the answer badly enough to make every caller await it.
    isBrave: g.navigator?.brave !== undefined,
  };
}

