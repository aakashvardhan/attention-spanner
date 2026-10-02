/**
 * What the browser running this extension can actually do.
 *
 * Chromium is not one browser. Brave ships the same extension APIs but strips
 * Google-backed web platform features. The speech and Gemini Nano flags that
 * used to live here went with the assistant (v22) and the move to Ollama for
 * local inference, which works the same in every Chromium.
 *
 * `isBrave` is all that is left, and it exists for the cosmetic skin
 * (theme.ts, `resolveSkin`) and for settings copy that names the browser —
 * never to gate a feature. Anything that changes what the extension can *do*
 * belongs behind feature detection, not a browser check.
 */

export interface Capabilities {
  /** Labelling and the cosmetic skin only. Never gate a feature on this. */
  isBrave: boolean;
}

export function detectCapabilities(): Capabilities {
  const g = globalThis as { navigator?: { brave?: unknown } };
  // navigator.brave exists only in Brave; isBrave() is async and we do not
  // need the answer badly enough to make every caller await it.
  return { isBrave: g.navigator?.brave !== undefined };
}
