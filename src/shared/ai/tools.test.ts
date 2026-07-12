import { describe, expect, it } from 'vitest';
import type { Task } from '../types';
import { resolveTaskByText, TOOLS, validateToolCall, type Tool } from './tools';

function task(id: string, text: string, completedAt: number | null = null): Task {
  return { id, text, createdAt: 0, completedAt, snoozedUntil: null, source: 'newtab' };
}

describe('TOOLS registry', () => {
  it('has unique names', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every required key exists in properties', () => {
    for (const tool of TOOLS) {
      for (const key of tool.params.required) {
        expect(tool.params.properties, `${tool.name}.${key}`).toHaveProperty(key);
      }
    }
  });

  const sampleFor = (spec: (typeof TOOLS)[number]['params']['properties'][string]): unknown =>
    spec.enum?.[0] ??
    (spec.type === 'number'
      ? (spec.minimum ?? 25)
      : spec.type === 'boolean'
        ? true
        : spec.type === 'array'
          ? [{ front: 'f', back: 'b' }]
          : 'text');

  it('summaries render for sample params', () => {
    for (const tool of TOOLS) {
      const sample: Record<string, unknown> = {};
      for (const [key, spec] of Object.entries(tool.params.properties)) {
        sample[key] = sampleFor(spec);
      }
      expect(typeof tool.summary(sample)).toBe('string');
      expect(tool.summary(sample).length).toBeGreaterThan(0);
    }
  });

  it('sample params round-trip validateToolCall', () => {
    for (const tool of TOOLS) {
      const sample: Record<string, unknown> = {};
      for (const [key, spec] of Object.entries(tool.params.properties)) {
        sample[key] = sampleFor(spec);
      }
      const res = validateToolCall(tool, sample);
      expect(res.ok, tool.name).toBe(true);
    }
  });
});

describe('validateToolCall', () => {
  const tool: Tool = {
    name: 't',
    description: '',
    params: {
      type: 'object',
      required: ['text'],
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '', maxLength: 5 },
        minutes: { type: 'number', description: '', minimum: 5, maximum: 240 },
        flag: { type: 'boolean', description: '' },
        page: { type: 'string', description: '', enum: ['a', 'b'] },
      },
    },
    summary: () => '',
    run: async () => '',
  };

  it('accepts valid params and strips unknown keys', () => {
    const res = validateToolCall(tool, { text: 'hi', junk: 1 });
    expect(res).toEqual({ ok: true, params: { text: 'hi' } });
  });

  it('coerces numeric strings and boolean strings', () => {
    const res = validateToolCall(tool, { text: 'hi', minutes: '25', flag: 'true' });
    expect(res).toEqual({ ok: true, params: { text: 'hi', minutes: 25, flag: true } });
  });

  it('rejects missing required keys', () => {
    const res = validateToolCall(tool, { minutes: 25 });
    expect(res.ok).toBe(false);
  });

  it('rejects out-of-range numbers and bad enums', () => {
    expect(validateToolCall(tool, { text: 'hi', minutes: 2 }).ok).toBe(false);
    expect(validateToolCall(tool, { text: 'hi', minutes: 999 }).ok).toBe(false);
    expect(validateToolCall(tool, { text: 'hi', page: 'z' }).ok).toBe(false);
  });

  it('clamps overlong strings to maxLength', () => {
    const res = validateToolCall(tool, { text: 'toolong!' });
    expect(res).toEqual({ ok: true, params: { text: 'toolo' } });
  });

  it('rejects non-object params', () => {
    expect(validateToolCall(tool, 'nope').ok).toBe(false);
    expect(validateToolCall(tool, [1]).ok).toBe(false);
    expect(validateToolCall(tool, null).ok).toBe(false);
  });

  it('treats empty strings as absent', () => {
    expect(validateToolCall(tool, { text: '' }).ok).toBe(false);
  });
});

describe('resolveTaskByText', () => {
  const tasks = [
    task('1', 'Email my advisor about the thesis'),
    task('2', 'Buy groceries'),
    task('3', 'Email the landlord'),
    task('4', 'Done task', 123),
  ];

  it('matches an exact task', () => {
    const res = resolveTaskByText(tasks, 'buy groceries');
    expect(res).toMatchObject({ kind: 'match', task: { id: '2' } });
  });

  it('matches a partial phrase', () => {
    const res = resolveTaskByText(tasks, 'the thesis email');
    expect(res).toMatchObject({ kind: 'match', task: { id: '1' } });
  });

  it('returns ambiguous when several tasks tie', () => {
    const res = resolveTaskByText(
      [task('a', 'Email Bob'), task('b', 'Email Sue')],
      'send the email',
    );
    expect(res.kind).toBe('ambiguous');
  });

  it('ignores completed tasks', () => {
    expect(resolveTaskByText(tasks, 'done task').kind).toBe('none');
  });

  it('returns none for unrelated queries', () => {
    expect(resolveTaskByText(tasks, 'water the plants').kind).toBe('none');
    expect(resolveTaskByText([], 'anything').kind).toBe('none');
  });
});
