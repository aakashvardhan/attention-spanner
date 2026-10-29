import { describe, expect, it } from 'vitest';
import { mathBlock, shouldLock } from './passGate';

const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
const base = { pass: 3 as const, pageText: prose, section: 1, lockedSections: new Set<number>(), openOnPage: false };

describe('passGate', () => {
  it('mathBlock finds Algorithm 1 and a Greek-heavy line, ignores prose with one "="', () => {
    expect(mathBlock('intro\nAlgorithm 1 Train loop\nfor x do')).toMatch(/^Algorithm 1 Train/);
    expect(mathBlock('text\nθ = θ − α∇L(θ) + βΣ_{t}\nmore')).toContain('∇L');
    expect(mathBlock('We set the rate x = 3 and then went on to read more prose here.')).toBe('');
    expect(mathBlock('Algorithm 2 ' + 'x'.repeat(900)).length).toBeLessThanOrEqual(400);
  });

  it('shouldLock false in passes 1–2 and on short pages', () => {
    expect(shouldLock({ ...base, pass: 1 })).toBe(false);
    expect(shouldLock({ ...base, pass: 2 })).toBe(false);
    expect(shouldLock({ ...base, pageText: 'short' })).toBe(false);
    expect(shouldLock(base)).toBe(true);
  });

  it('first page of a section locks, the next plain page does not', () => {
    expect(shouldLock(base)).toBe(true);
    expect(shouldLock({ ...base, lockedSections: new Set([1]) })).toBe(false);
  });

  it('no outline locks once, then only on math or open pages', () => {
    const l = new Set([0]);
    expect(shouldLock({ ...base, section: 0 })).toBe(true);
    expect(shouldLock({ ...base, section: 0, lockedSections: l })).toBe(false);
    expect(shouldLock({ ...base, section: 0, lockedSections: l, openOnPage: true })).toBe(true);
    expect(shouldLock({ ...base, section: 0, lockedSections: l, pageText: prose + '\nAlgorithm 1 Go' })).toBe(true);
  });
});
