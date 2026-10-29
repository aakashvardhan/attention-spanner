import { describe, expect, it } from 'vitest';
import type { Provocation } from '../../shared/types';
import { justifiedPages, mathBlock, pageToLock, shouldLock } from './passGate';

const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
const base = { pass: 3 as const, pageText: prose, section: 1, lockedSections: new Set<number>(), openOnPage: false };

describe('passGate', () => {
  it('mathBlock finds Algorithm 1 and a Greek-heavy line, ignores prose with one "="', () => {
    expect(mathBlock('intro\nAlgorithm 1 Train loop\nfor x do')).toMatch(/^Algorithm 1 Train/);
    expect(mathBlock('text\nθ = θ − α∇L(θ) + βΣ_{t}\nmore')).toContain('∇L');
    expect(mathBlock('We set the rate x = 3 and then went on to read more prose here.')).toBe('');
    expect(mathBlock('| a | b | c | d | e | f | g | h |')).toBe('');
    expect(mathBlock('Use the (foo_bar) and (baz_qux) helpers (see below) to set x = 3 in the (usual_way) of doing it.')).toBe('');
    expect(mathBlock('As shown, see Algorithm 1 for details on the method.')).toBe('');
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

  it('pageToLock asks about the page being left, only moving forward, never on open', () => {
    const o = {
      left: 1 as number | null,
      page: 2,
      pass: 3 as const,
      pageTexts: [prose, prose, prose],
      sectionOf: () => 0,
      lockedSections: new Set<number>(),
      justified: new Set<number>(),
      openPages: new Set<number>(),
    };
    expect(pageToLock(o)).toBe(1);
    expect(pageToLock({ ...o, left: null, page: 1 })).toBeNull();
    expect(pageToLock({ ...o, left: 3, page: 2 })).toBeNull();
    expect(pageToLock({ ...o, justified: new Set([1]) })).toBeNull();
    expect(pageToLock({ ...o, pass: 2 })).toBeNull();
    expect(pageToLock({ ...o, lockedSections: new Set([0]) })).toBeNull();
    expect(pageToLock({ ...o, lockedSections: new Set([0]), openPages: new Set([1]) })).toBe(1);
    expect(pageToLock({ ...o, left: 1, page: 3 })).toBe(1);
  });

  it('justifiedPages: answered locks and resolved records of this document only', () => {
    const rec = (p: Partial<Provocation>): Provocation => ({
      id: 'x', docKey: 'k', paperId: null, page: 1, kind: 'lock', question: 'q', answer: 'a',
      status: 'answered', annotationId: null, xp: 0, createdAt: 0, updatedAt: 0, ...p,
    });
    const pages = justifiedPages(
      [
        rec({ page: 1 }),
        rec({ page: 2, kind: 'equation', xp: 10 }),
        rec({ page: 3, kind: 'equation', xp: 0 }),
        rec({ page: 4, status: 'unsure' }),
        rec({ page: 5, docKey: 'other' }),
        rec({ page: 6, kind: 'verdict', xp: 20 }),
      ],
      'k',
    );
    expect([...pages].sort()).toEqual([1, 2]);
  });
});
