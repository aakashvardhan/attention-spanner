import { describe, expect, it } from 'vitest';
import { OllamaError, parseChatLine, takeLines } from './ollama';

describe('takeLines', () => {
  it('keeps a partial trailing line for the next chunk', () => {
    expect(takeLines('{"a":1}\n{"b":')).toEqual({ lines: ['{"a":1}'], rest: '{"b":' });
  });

  it('reassembles a line split across two network chunks', () => {
    const first = takeLines('{"message":{"content":"Hel');
    expect(first.lines).toEqual([]);
    const second = takeLines(`${first.rest}lo"}}\n`);
    expect(second.lines.map(parseChatLine)).toEqual(['Hello']);
    expect(second.rest).toBe('');
  });

  it('skips blank lines', () => {
    expect(takeLines('\n\n{"x":1}\n\n').lines).toEqual(['{"x":1}']);
  });
});

describe('parseChatLine', () => {
  it('reads the content delta', () => {
    expect(parseChatLine('{"message":{"role":"assistant","content":"Hi"},"done":false}')).toBe('Hi');
  });

  it('reads the final done line as nothing to add', () => {
    expect(parseChatLine('{"done":true,"total_duration":123}')).toBe('');
  });

  it('turns an in-band error into a thrown OllamaError', () => {
    expect(() => parseChatLine('{"error":"model ran out of memory"}')).toThrow(OllamaError);
  });
});
