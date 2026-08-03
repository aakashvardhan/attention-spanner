import { describe, expect, it } from 'vitest';
import { EMPTY_VISIBLE, EMPTY_VIEW, isGraphOpen, nextView, resolveTopic } from './graphView';

describe('nextView', () => {
  // chrome.storage fires no change event for a byte-identical write, so asking
  // twice for the same topic would leave the second request looking like it
  // did nothing. The nonce is what makes every write an event.
  it('bumps the nonce even when nothing else changed', () => {
    const first = nextView(EMPTY_VIEW, { topic: 'rlhf' });
    const again = nextView(first, { topic: 'rlhf' });

    expect(again.topic).toBe('rlhf');
    expect(again.nonce).toBeGreaterThan(first.nonce);
  });

  // A focus is a command, not a setting. Left in place, the next unrelated
  // write would re-select a node the user had just dismissed.
  it('clears the focus on any write that does not set one', () => {
    const focused = nextView(EMPTY_VIEW, { focusId: 'paper:p1' });
    const later = nextView(focused, { topic: 'rlhf' });

    expect(focused.focusId).toBe('paper:p1');
    expect(later.focusId).toBe('');
  });

  it('leaves untouched fields alone', () => {
    const filtered = nextView(EMPTY_VIEW, { topic: 'rlhf', hiddenKinds: ['video'] });
    const next = nextView(filtered, { focusId: 'paper:p1' });

    expect(next).toMatchObject({ topic: 'rlhf', hiddenKinds: ['video'] });
  });

  it('can be cleared back to everything', () => {
    const filtered = nextView(EMPTY_VIEW, { topic: 'rlhf', hiddenKinds: ['video'] });
    const cleared = nextView(filtered, { topic: '', hiddenKinds: [] });

    expect(cleared).toMatchObject({ topic: '', hiddenKinds: [] });
  });
});

describe('resolveTopic', () => {
  const topics = ['diffusion models', 'reinforcement learning', 'sleep research'];

  it('takes an exact topic', () => {
    expect(resolveTopic('sleep research', topics)).toBe('sleep research');
  });

  it('finds the full topic from part of it', () => {
    expect(resolveTopic('diffusion', topics)).toBe('diffusion models');
  });

  it('prefers an exact match over a longer one containing it', () => {
    expect(resolveTopic('diffusion', ['diffusion', 'diffusion models'])).toBe('diffusion');
  });

  // The failure this prevents: a model invents a topic, the page filters to
  // nothing, and the user stares at an empty graph with nothing saying why.
  it('returns nothing for a topic that is not in use', () => {
    expect(resolveTopic('quantum computing', topics)).toBe(null);
  });

  it('returns nothing for an empty request', () => {
    expect(resolveTopic('   ', topics)).toBe(null);
  });
});

describe('isGraphOpen', () => {
  const NOW = 1_700_000_000_000;
  const STALE = 45_000;
  const showing = (updatedAt: number) => ({ ...EMPTY_VISIBLE, updatedAt });

  it('is open while the page is still saying so', () => {
    expect(isGraphOpen(showing(NOW - 10_000), NOW, STALE)).toBe(true);
  });

  // The bug this replaced: React cleanup does not run when a page is navigated
  // away from, and the storage write it would issue never lands — so a digest
  // from a closed tab sat there looking current, and the assistant went on
  // describing a screen nobody had.
  it('is closed once the page has gone quiet', () => {
    expect(isGraphOpen(showing(NOW - 60_000), NOW, STALE)).toBe(false);
  });

  it('is closed when the page has never been open at all', () => {
    expect(isGraphOpen(EMPTY_VISIBLE, NOW, STALE)).toBe(false);
  });

  // A background tab gets its timers throttled, so the window has to clear
  // more than one missed heartbeat before silence means anything.
  it('survives a single missed heartbeat', () => {
    expect(isGraphOpen(showing(NOW - 20_000), NOW, STALE)).toBe(true);
  });
});
