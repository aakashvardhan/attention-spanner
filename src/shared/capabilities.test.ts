import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectCapabilities } from './capabilities';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectCapabilities', () => {
  it('reports nothing when no globals are present (the vitest baseline)', () => {
    const caps = detectCapabilities();
    expect(caps.webSpeech).toBe(false);
    expect(caps.promptApi).toBe(false);
    expect(caps.isBrave).toBe(false);
  });

  it('accepts either spelling of the speech constructor', () => {
    vi.stubGlobal('webkitSpeechRecognition', class {});
    expect(detectCapabilities().webSpeech).toBe(true);

    vi.unstubAllGlobals();
    vi.stubGlobal('SpeechRecognition', class {});
    expect(detectCapabilities().webSpeech).toBe(true);
  });

  it('sees Gemini Nano only when LanguageModel is defined', () => {
    expect(detectCapabilities().promptApi).toBe(false);
    vi.stubGlobal('LanguageModel', { availability: () => 'available' });
    expect(detectCapabilities().promptApi).toBe(true);
  });

  it('detects Brave by navigator.brave, without calling the async isBrave()', () => {
    vi.stubGlobal('navigator', { brave: { isBrave: () => Promise.resolve(true) } });
    expect(detectCapabilities().isBrave).toBe(true);
  });

  /* The shape this whole module exists for: Brave keeps the extension APIs and
     drops the Google-backed web platform ones. */
  it('describes Brave: extension APIs present, speech and Nano absent', () => {
    vi.stubGlobal('navigator', { brave: {} });
    vi.stubGlobal('chrome', { sidePanel: { open() {} } });
    vi.stubGlobal('speechSynthesis', {});
    const caps = detectCapabilities();
    expect(caps).toEqual({
      webSpeech: false,
      promptApi: false,
      speechSynthesis: true,
      sidePanel: true,
      isBrave: true,
    });
  });

  it('treats a chrome object without sidePanel as lacking it', () => {
    vi.stubGlobal('chrome', { runtime: {} });
    expect(detectCapabilities().sidePanel).toBe(false);
  });
});

