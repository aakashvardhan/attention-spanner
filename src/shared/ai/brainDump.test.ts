import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAvailability, parseStructuredResult, pickDumpEngine } from './brainDump';

afterEach(() => vi.unstubAllGlobals());

describe('getAvailability', () => {
  it('declares English input and output for the LanguageModel probe', async () => {
    const availability = vi.fn().mockResolvedValue('available');
    vi.stubGlobal('LanguageModel', { availability });

    await expect(getAvailability()).resolves.toBe('available');
    expect(availability).toHaveBeenCalledWith({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    });
  });
});

describe('pickDumpEngine', () => {
  it('prefers Nano whenever the device can run it, key or not', () => {
    expect(pickDumpEngine({ nano: 'available', cloud: false })).toBe('nano');
    expect(pickDumpEngine({ nano: 'available', cloud: true })).toBe('nano');
    // 'downloadable' counts — the first create() starts the one-time download
    expect(pickDumpEngine({ nano: 'downloadable', cloud: true })).toBe('nano');
  });

  it('falls back to the cloud where there is no Nano (Brave, older Chrome)', () => {
    expect(pickDumpEngine({ nano: 'unavailable', cloud: true })).toBe('cloud');
  });

  it('uses the cloud rather than waiting out an in-flight model download', () => {
    expect(pickDumpEngine({ nano: 'downloading', cloud: true })).toBe('cloud');
  });

  it('has nothing to offer without Nano or a key', () => {
    expect(pickDumpEngine({ nano: 'unavailable', cloud: false })).toBe('none');
    expect(pickDumpEngine({ nano: 'downloading', cloud: false })).toBe('none');
  });
});

describe('parseStructuredResult', () => {
  it('parses plain valid JSON', () => {
    const result = parseStructuredResult(
      '{"bullets": ["Thought one", "Thought two"], "tasks": ["Email advisor"]}',
    );
    expect(result.bullets).toEqual(['Thought one', 'Thought two']);
    expect(result.tasks).toEqual(['Email advisor']);
  });

  it('strips markdown code fences', () => {
    const result = parseStructuredResult(
      '```json\n{"bullets": ["A"], "tasks": ["Do thing"]}\n```',
    );
    expect(result.bullets).toEqual(['A']);
    expect(result.tasks).toEqual(['Do thing']);
  });

  it('strips bare code fences without language tag', () => {
    const result = parseStructuredResult('```\n{"bullets": ["A"], "tasks": []}\n```');
    expect(result.bullets).toEqual(['A']);
  });

  it('throws on truncated JSON', () => {
    expect(() => parseStructuredResult('{"bullets": ["A", "B')).toThrow('invalid JSON');
  });

  it('throws on non-object JSON', () => {
    expect(() => parseStructuredResult('"just a string"')).toThrow('non-object');
    expect(() => parseStructuredResult('null')).toThrow('non-object');
  });

  it('throws when nothing usable is present', () => {
    expect(() => parseStructuredResult('{"bullets": [], "tasks": []}')).toThrow('no usable');
    expect(() => parseStructuredResult('{"other": "stuff"}')).toThrow('no usable');
    expect(() => parseStructuredResult('{"bullets": [1, 2], "tasks": [null]}')).toThrow(
      'no usable',
    );
  });

  it('tolerates one field having the wrong shape', () => {
    const result = parseStructuredResult('{"bullets": "oops", "tasks": ["Fix it"]}');
    expect(result.bullets).toEqual([]);
    expect(result.tasks).toEqual(['Fix it']);
  });

  it('trims leading bullet markers and whitespace, drops empties and dupes', () => {
    const result = parseStructuredResult(
      '{"bullets": ["- item one", "• item two", "  ", "item one"], "tasks": ["* Call mom", "Call mom"]}',
    );
    expect(result.bullets).toEqual(['item one', 'item two']);
    expect(result.tasks).toEqual(['Call mom']);
  });

  it('clamps over-limit arrays', () => {
    const bullets = JSON.stringify(Array.from({ length: 20 }, (_, i) => `b${i}`));
    const tasks = JSON.stringify(Array.from({ length: 20 }, (_, i) => `t${i}`));
    const result = parseStructuredResult(`{"bullets": ${bullets}, "tasks": ${tasks}}`);
    expect(result.bullets).toHaveLength(3);
    expect(result.tasks).toHaveLength(1);
  });
});
