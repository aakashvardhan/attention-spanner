import { describe, expect, it } from 'vitest';
import {
  appendLiveAnswer,
  attachFollowUps,
  countLive,
  findPreset,
  idleLiveSession,
  isLiveActive,
  LISTEN_PRESETS,
  MAX_ANSWERED_HASHES,
  MAX_LIVE_ANSWERS,
  newLiveSession,
  pinLiveSkill,
  setLiveBusy,
  setLiveMode,
  setLivePace,
  type LiveAnswer,
} from './live';

function answer(id: string, text = 'because of the index'): LiveAnswer {
  return { id, question: 'why is it slow', text, atSec: 10, createdAt: 1 };
}

describe('session lifecycle', () => {
  it('starts idle and inactive', () => {
    const idle = idleLiveSession();
    expect(isLiveActive(idle)).toBe(false);
    expect(idle.answers).toEqual([]);
  });

  it('is active once attached to a recording', () => {
    expect(isLiveActive(newLiveSession('rec-1'))).toBe(true);
  });

  it('defaults to question mode at a balanced pace', () => {
    const s = newLiveSession('rec-1');
    expect(s.mode).toBe('question');
    expect(s.pace).toBe('balanced');
    expect(s.skillId).toBe('');
  });
});

describe('appendLiveAnswer', () => {
  it('appends, stamps the cooldown clock and clears busy', () => {
    const s = appendLiveAnswer(setLiveBusy(newLiveSession('rec-1'), true), answer('a'), 'h1', 500);
    expect(s.answers).toHaveLength(1);
    expect(s.lastAnswerAt).toBe(500);
    expect(s.busy).toBe(false);
    expect(s.error).toBe('');
  });

  it('remembers the question hash so a repeat is suppressed', () => {
    const s = appendLiveAnswer(newLiveSession('rec-1'), answer('a'), 'h1', 500);
    expect(s.answered).toContain('h1');
  });

  it('does not record a hash for an unprompted answer', () => {
    // A pause-triggered answer has no question to be a duplicate of.
    expect(appendLiveAnswer(newLiveSession('rec-1'), answer('a'), '', 500).answered).toEqual([]);
  });

  it('keeps one entry per repeated hash rather than growing', () => {
    let s = appendLiveAnswer(newLiveSession('rec-1'), answer('a'), 'h1', 1);
    s = appendLiveAnswer(s, answer('b'), 'h1', 2);
    expect(s.answered).toEqual(['h1']);
  });

  it('caps answers newest-wins', () => {
    let s = newLiveSession('rec-1');
    for (let i = 0; i < MAX_LIVE_ANSWERS + 5; i++) s = appendLiveAnswer(s, answer(`a${i}`), '', i);
    expect(s.answers).toHaveLength(MAX_LIVE_ANSWERS);
    expect(s.answers[s.answers.length - 1].id).toBe(`a${MAX_LIVE_ANSWERS + 4}`);
  });

  it('caps the answered-hash history', () => {
    let s = newLiveSession('rec-1');
    for (let i = 0; i < MAX_ANSWERED_HASHES + 10; i++) s = appendLiveAnswer(s, answer('a'), `h${i}`, i);
    expect(s.answered).toHaveLength(MAX_ANSWERED_HASHES);
  });
});

describe('attachFollowUps', () => {
  it('attaches to the named answer only', () => {
    let s = appendLiveAnswer(newLiveSession('rec-1'), answer('a'), '', 1);
    s = appendLiveAnswer(s, answer('b'), '', 2);
    s = attachFollowUps(s, 'a', ['what about writes']);
    expect(s.answers[0].followUps).toEqual(['what about writes']);
    expect(s.answers[1].followUps).toBeUndefined();
  });

  it('is a no-op for an answer that has aged out of the cap', () => {
    const s = attachFollowUps(newLiveSession('rec-1'), 'gone', ['x']);
    expect(s.answers).toEqual([]);
  });
});

describe('countLive', () => {
  it('tallies each kind independently', () => {
    let s = newLiveSession('rec-1');
    expect(s.stats).toEqual({ answers: 0, chips: 0, cacheHits: 0 });
    s = countLive(countLive(s, 'answers'), 'cacheHits');
    s = countLive(s, 'answers');
    expect(s.stats).toEqual({ answers: 2, chips: 0, cacheHits: 1 });
  });
});

describe('listen presets', () => {
  it('resolves a preset by id and nothing else', () => {
    expect(findPreset('preset:interview')?.name).toBe('Interview');
    // A user skill id, or a preset deleted in a later version, must fall through
    // to the plain persona rather than throwing mid-meeting.
    expect(findPreset('some-user-skill')).toBeUndefined();
    expect(findPreset('')).toBeUndefined();
  });

  it('gives every preset a namespaced id and a non-empty body', () => {
    // The namespace is what lets one skillId field hold both presets and user
    // skill ids without them ever colliding.
    for (const p of LISTEN_PRESETS) {
      expect(p.id.startsWith('preset:')).toBe(true);
      expect(p.body.trim()).not.toBe('');
    }
  });
});

describe('setters', () => {
  it('set mode, pace and pinned skill without touching answers', () => {
    const withAnswer = appendLiveAnswer(newLiveSession('rec-1'), answer('a'), '', 1);
    expect(setLiveMode(withAnswer, 'manual').mode).toBe('manual');
    expect(setLivePace(withAnswer, 'fast').pace).toBe('fast');
    expect(pinLiveSkill(withAnswer, 'interview').skillId).toBe('interview');
    expect(setLiveMode(withAnswer, 'manual').answers).toHaveLength(1);
  });

  it('records the reason when busy is released by a failure', () => {
    const s = setLiveBusy(newLiveSession('rec-1'), false, 'timed out');
    expect(s.busy).toBe(false);
    expect(s.error).toBe('timed out');
  });
});
