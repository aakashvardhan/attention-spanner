import { describe, expect, it } from 'vitest';
import { GLOBAL_NUDGE_GAP_MS, nudgeEligible } from './nudges';

const now = 10 * GLOBAL_NUDGE_GAP_MS;
const item = { percent: 40, unfinished: true, activeSeconds: 120, nudge: { count: 0, lastAt: 0, dismissed: false } };

describe('nudgeEligible', () => {
  it('nudges a half-read item nobody has been nudged about lately', () => {
    expect(nudgeEligible(item, 0, now)).toBe(true);
  });

  it('holds back for a skim, a finish, a dismiss, the cap and the global gap', () => {
    expect(nudgeEligible({ ...item, percent: 2 }, 0, now)).toBe(false);
    expect(nudgeEligible({ ...item, percent: 95 }, 0, now)).toBe(false);
    expect(nudgeEligible({ ...item, unfinished: false }, 0, now)).toBe(false);
    expect(nudgeEligible({ ...item, activeSeconds: 10 }, 0, now)).toBe(false);
    expect(nudgeEligible({ ...item, nudge: { ...item.nudge, dismissed: true } }, 0, now)).toBe(false);
    expect(nudgeEligible({ ...item, nudge: { ...item.nudge, count: 2 } }, 0, now)).toBe(false);
    expect(nudgeEligible(item, now - 1000, now)).toBe(false);
  });

  // Papers have no active-seconds count, so firePaperNudge passes Infinity.
  it('lets a paper through on progress alone', () => {
    expect(nudgeEligible({ ...item, activeSeconds: Infinity }, 0, now)).toBe(true);
  });
});
