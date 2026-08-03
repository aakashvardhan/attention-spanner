import { afterEach, describe, expect, it, vi } from 'vitest';
import { sttAvailability } from './stt';
import { classifyError } from './webSpeechStt';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stand up a browser that has the Web Speech API */
function withWebSpeech() {
  vi.stubGlobal('webkitSpeechRecognition', class {});
}

/** Stand up Brave: extension APIs, no Web Speech */
function withBrave() {
  vi.stubGlobal('navigator', { brave: {} });
}

describe('sttAvailability', () => {
  it('prefers the built-in engine and reports no upload', () => {
    withWebSpeech();
    expect(sttAvailability(false)).toEqual({ usable: true, cloud: false, reason: '' });
  });

  it('still prefers the built-in engine when a Gemini key exists', () => {
    withWebSpeech();
    expect(sttAvailability(true).cloud).toBe(false);
  });

  it('falls back to cloud transcription when Web Speech is absent but a key is set', () => {
    withBrave();
    expect(sttAvailability(true)).toEqual({ usable: true, cloud: true, reason: '' });
  });

  /* The case that must not be silent: nothing can transcribe, so the surface
     needs words explaining why rather than a mic button that does nothing. */
  it('is unusable with neither engine, and names Brave when that is the reason', () => {
    withBrave();
    const result = sttAvailability(false);
    expect(result.usable).toBe(false);
    expect(result.reason).toContain('Brave');
    expect(result.reason).toContain('Gemini API key');
  });

  it('avoids naming Brave in a browser that merely lacks the API', () => {
    const result = sttAvailability(false);
    expect(result.usable).toBe(false);
    expect(result.reason).toContain('This browser');
    expect(result.reason).not.toContain('Brave');
  });
});

describe('classifyError', () => {
  it('maps permission refusals onto denied', () => {
    expect(classifyError('not-allowed')).toBe('denied');
    expect(classifyError('service-not-allowed')).toBe('denied');
  });

  it('maps unreachable-service errors onto network', () => {
    expect(classifyError('network')).toBe('network');
    expect(classifyError('audio-capture')).toBe('network');
  });

  /* Kept distinct from 'network' on purpose: an always-on listener sees
     no-speech constantly in a quiet room, and treating it as a failure is what
     drove the wake listener's backoff ladder to its 60s rung. */
  it('keeps no-speech separate from real failures', () => {
    expect(classifyError('no-speech')).toBe('no-speech');
  });

  it('falls through to other for anything unrecognized', () => {
    expect(classifyError('aborted')).toBe('other');
    expect(classifyError('bad-grammar')).toBe('other');
  });
});
