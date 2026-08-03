import { describe, expect, it } from 'vitest';
import { TOOLS } from '../tools';
import type { Tool } from '../tools';
import {
  callSignature,
  canRun,
  checkBudgets,
  classifyToolUse,
  DEFAULT_BUDGETS,
} from './guardrails';
import { beginScratchpad, type Scratchpad } from './scratchpad';

const base = (over: Partial<Scratchpad> = {}): Scratchpad => ({
  ...beginScratchpad(Date.now() + 60_000),
  ...over,
});

const fakeTool = (over: Partial<Tool> = {}): Tool => ({
  name: 'x',
  description: 'x',
  params: { type: 'object', required: [], additionalProperties: false, properties: {} },
  summary: () => 'x',
  run: async () => 'x',
  ...over,
});

describe('classifyToolUse', () => {
  it('stages an unannotated tool — the fail-closed default', () => {
    expect(classifyToolUse(fakeTool())).toBe('stage');
  });

  it('honors an explicit annotation', () => {
    expect(classifyToolUse(fakeTool({ loop: 'auto' }))).toBe('auto');
    expect(classifyToolUse(fakeTool({ loop: 'costly' }))).toBe('costly');
  });

  it('confirm:true overrides any annotation', () => {
    expect(classifyToolUse(fakeTool({ confirm: true, loop: 'auto' }))).toBe('stage');
  });
});

describe('the real tool registry', () => {
  it('classifies every tool deliberately — no tool relies on the default', () => {
    // A new connector must state how the loop may use its tools. Without this,
    // the fail-closed default silently stages a read-only tool and the loop
    // quietly gets worse instead of louder.
    const undecided = TOOLS.filter((t) => !t.confirm && t.loop === undefined).map((t) => t.name);
    expect(undecided).toEqual([]);
  });

  it('never marks a mutating tool auto-runnable', () => {
    const unsafe = TOOLS.filter((t) => t.confirm && t.loop && t.loop !== 'stage').map((t) => t.name);
    expect(unsafe).toEqual([]);
  });
});

describe('callSignature', () => {
  it('is insensitive to key order, so a reordered call still counts as a repeat', () => {
    expect(callSignature('t', { a: 1, b: 2 })).toBe(callSignature('t', { b: 2, a: 1 }));
  });

  it('distinguishes different values and different tools', () => {
    expect(callSignature('t', { a: 1 })).not.toBe(callSignature('t', { a: 2 }));
    expect(callSignature('t', { a: 1 })).not.toBe(callSignature('u', { a: 1 }));
  });

  it('does not confuse the string "1" with the number 1', () => {
    expect(callSignature('t', { a: 1 })).not.toBe(callSignature('t', { a: '1' }));
  });
});

describe('checkBudgets', () => {
  const now = Date.now();

  it('returns null while there is room', () => {
    expect(checkBudgets(base(), now)).toBeNull();
  });

  it('trips each dimension independently', () => {
    expect(checkBudgets(base({ iterations: 6 }), now)).toBe('iterations');
    expect(checkBudgets(base({ steps: new Array(8).fill(null) as never }), now)).toBe('tool-calls');
    expect(checkBudgets(base({ costlyCalls: 2 }), now)).toBe('costly-calls');
    expect(checkBudgets(base({ staged: new Array(5).fill(null) as never }), now)).toBe('staged');
    expect(checkBudgets(base({ toolErrors: 3 }), now)).toBe('tool-errors');
  });

  it('the deadline wins over every other ceiling', () => {
    const expired = base({ deadlineAt: now - 1, iterations: 99 });
    expect(checkBudgets(expired, now)).toBe('deadline');
  });

  it('respects injected budgets', () => {
    expect(checkBudgets(base({ iterations: 1 }), now, { ...DEFAULT_BUDGETS, maxIterations: 1 })).toBe(
      'iterations',
    );
  });
});

describe('canRun', () => {
  it('checks each class against its own ceiling', () => {
    expect(canRun(base({ costlyCalls: 2 }), 'costly')).toBe(false);
    // A used-up costly budget does not stop a cheap local read
    expect(canRun(base({ costlyCalls: 2 }), 'auto')).toBe(true);
    expect(canRun(base({ staged: new Array(5).fill(null) as never }), 'stage')).toBe(false);
    expect(canRun(base({ staged: new Array(5).fill(null) as never }), 'auto')).toBe(true);
  });
});
