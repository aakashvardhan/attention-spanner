import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '../recordings';
import {
  detectQuestion,
  liveAnswerCacheKey,
  PACE_MIN_GAP_MS,
  questionHash,
  recentWindow,
  shouldAutoAnswer,
} from './liveTriggers';

describe('detectQuestion', () => {
  it('catches an ordinary punctuated question', () => {
    expect(detectQuestion('So the deadline moved. What does that do to scope?')).toBe(
      'What does that do to scope',
    );
  });

  it('catches an unpunctuated question, which is the normal transcript case', () => {
    // Live STT rarely punctuates; the '?' test alone would miss most real asks.
    expect(detectQuestion('okay so how do you handle retries here')).toBe(
      'okay so how do you handle retries here',
    );
  });

  it('catches conversational asks that are not interrogative at all', () => {
    expect(detectQuestion('Walk me through your experience with distributed systems')).toBeTruthy();
    expect(detectQuestion('Tell us about a time you disagreed with a lead')).toBeTruthy();
    expect(detectQuestion('Any thoughts on the migration plan')).toBeTruthy();
  });

  it('returns the LAST question, the one still hanging in the air', () => {
    const text = 'What about caching? We covered that. So what is the rollout plan?';
    expect(detectQuestion(text)).toBe('So what is the rollout plan');
  });

  it('strips a speaker label so the opener is visible', () => {
    expect(detectQuestion('Speaker 2: why did we pick Postgres')).toBe('why did we pick Postgres');
  });

  it('returns null for ordinary statements', () => {
    expect(detectQuestion('We shipped the migration on Tuesday and it went fine.')).toBeNull();
    expect(detectQuestion('The latency dropped to about forty milliseconds.')).toBeNull();
  });

  it('trusts a period when the transcriber punctuated the sentence', () => {
    // "Now is the time..." reads as interrogative once the filler is stripped.
    // The terminal period is the only thing distinguishing it, so it counts.
    expect(detectQuestion('Now is the time to cut the release.')).toBeNull();
    expect(detectQuestion('So we shipped the migration on Tuesday.')).toBeNull();
  });

  it('still catches a conversational ask that ends in a period', () => {
    // The narrow patterns run regardless of punctuation — being specific is
    // what earns them that.
    expect(detectQuestion('Walk me through your experience with distributed systems.')).toBeTruthy();
  });

  it('ignores fragments too short to be a real ask', () => {
    expect(detectQuestion('why')).toBeNull();
    expect(detectQuestion('')).toBeNull();
  });
});

describe('shouldAutoAnswer', () => {
  const base = { msSinceLastAnswer: 60_000, pace: 'balanced' as const, busy: false, duplicate: false };

  it('answers once the pace gap has passed', () => {
    expect(shouldAutoAnswer(base)).toBe(true);
  });

  it('refuses while an answer is in flight', () => {
    expect(shouldAutoAnswer({ ...base, busy: true })).toBe(false);
  });

  it('refuses a duplicate however long ago the last answer was', () => {
    // The cost gate that matters: a question echoed by a second speaker, or
    // split across a segment boundary, must not be billed twice.
    expect(shouldAutoAnswer({ ...base, msSinceLastAnswer: 10 ** 7, duplicate: true })).toBe(false);
  });

  it('enforces each pace tier', () => {
    for (const pace of ['fast', 'balanced', 'relaxed'] as const) {
      const gap = PACE_MIN_GAP_MS[pace];
      expect(shouldAutoAnswer({ ...base, pace, msSinceLastAnswer: gap })).toBe(true);
      expect(shouldAutoAnswer({ ...base, pace, msSinceLastAnswer: gap - 1 })).toBe(false);
    }
  });

  it('orders the tiers fast < balanced < relaxed', () => {
    expect(PACE_MIN_GAP_MS.fast).toBeLessThan(PACE_MIN_GAP_MS.balanced);
    expect(PACE_MIN_GAP_MS.balanced).toBeLessThan(PACE_MIN_GAP_MS.relaxed);
  });
});

describe('recentWindow', () => {
  const segments: TranscriptSegment[] = [
    { startSec: 0, endSec: 30, text: 'old news' },
    { startSec: 600, endSec: 630, text: 'recent talk' },
    { startSec: 630, endSec: 660, text: 'newest talk' },
  ];

  it('keeps only segments inside the window', () => {
    const out = recentWindow(segments, 660, 120);
    expect(out).not.toContain('old news');
    expect(out).toContain('recent talk');
    expect(out).toContain('newest talk');
  });

  it('timestamps each line so an answer can be traced back', () => {
    expect(recentWindow(segments, 660, 120)).toContain('[10:00]');
  });

  it('drops empty segments and returns empty when nothing is in range', () => {
    expect(recentWindow([{ startSec: 0, endSec: 5, text: '   ' }], 5, 120)).toBe('');
    expect(recentWindow(segments, 10_000, 60)).toBe('');
  });
});

describe('cache keys', () => {
  it('ignores case, spacing and trailing punctuation', () => {
    expect(liveAnswerCacheKey('What is the plan?', 's1')).toBe(
      liveAnswerCacheKey('  what  is the PLAN  ', 's1'),
    );
  });

  it('separates the same question under different pinned skills', () => {
    // Interview mode and Meeting mode want different answers to one question.
    expect(liveAnswerCacheKey('what is the plan', 'interview')).not.toBe(
      liveAnswerCacheKey('what is the plan', 'meeting'),
    );
  });

  it('hashes questions for dedup independently of the skill', () => {
    expect(questionHash('Why Postgres?')).toBe(questionHash('why postgres'));
    expect(questionHash('Why Postgres?')).not.toBe(questionHash('why mysql'));
  });
});
