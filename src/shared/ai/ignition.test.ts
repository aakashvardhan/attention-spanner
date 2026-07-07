import { describe, expect, it } from 'vitest';
import { MAX_FIRST_ACTION_CHARS, parseIgnitionResult } from './ignition';

describe('parseIgnitionResult', () => {
  it('parses a plain JSON response', () => {
    expect(parseIgnitionResult('{"firstAction": "Open the doc and write one bad sentence"}')).toBe(
      'Open the doc and write one bad sentence',
    );
  });

  it('strips code fences', () => {
    expect(parseIgnitionResult('```json\n{"firstAction": "Put shoes by the door"}\n```')).toBe(
      'Put shoes by the door',
    );
  });

  it('strips bullet markers and wrapping quotes', () => {
    expect(parseIgnitionResult('{"firstAction": "- \\"Open the tab\\""}')).toBe('Open the tab');
  });

  it('clamps overlong actions', () => {
    const long = 'a'.repeat(500);
    expect(parseIgnitionResult(`{"firstAction": "${long}"}`)).toHaveLength(MAX_FIRST_ACTION_CHARS);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseIgnitionResult('first: do the thing')).toThrow('invalid JSON');
  });

  it('throws on missing or empty firstAction', () => {
    expect(() => parseIgnitionResult('{"action": "x"}')).toThrow('no first action');
    expect(() => parseIgnitionResult('{"firstAction": "  "}')).toThrow('empty');
    expect(() => parseIgnitionResult('null')).toThrow('non-object');
  });
});
