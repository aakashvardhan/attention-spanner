import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectCapabilities, probeWasm } from './capabilities';

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
    vi.stubGlobal('chrome', { tts: { speak() {} }, sidePanel: { open() {} } });
    const caps = detectCapabilities();
    expect(caps).toEqual({
      webSpeech: false,
      promptApi: false,
      tts: true,
      sidePanel: true,
      isBrave: true,
    });
  });

  it('treats a chrome object without tts/sidePanel as lacking them', () => {
    vi.stubGlobal('chrome', { runtime: {} });
    const caps = detectCapabilities();
    expect(caps.tts).toBe(false);
    expect(caps.sidePanel).toBe(false);
  });
});

describe('probeWasm', () => {
  it('instantiates the empty module when WebAssembly is usable', async () => {
    await expect(probeWasm()).resolves.toBe(true);
  });

  it('is false when instantiation throws, even though the API exists', async () => {
    vi.stubGlobal('WebAssembly', {
      instantiate: () => Promise.reject(new Error('blocked by CSP')),
    });
    await expect(probeWasm()).resolves.toBe(false);
  });

  it('is false when WebAssembly is absent entirely', async () => {
    vi.stubGlobal('WebAssembly', undefined);
    await expect(probeWasm()).resolves.toBe(false);
  });
});
