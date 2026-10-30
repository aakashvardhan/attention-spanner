import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleVideoProgress, handleVideoReady } from './videoTracking';
import { gateNewItem } from './topicGate';
import { DEFAULT_SETTINGS } from '../shared/storage';
import { videoKey } from '../shared/youtube';

// The real gate, watched; Gemini answers "off topic" to anything the keywords miss.
vi.mock('./topicGate', async (actual) => {
  const real = await actual<typeof import('./topicGate')>();
  return { ...real, gateNewItem: vi.fn(real.gateNewItem) };
});
vi.mock('../shared/llm/geminiTopic', () => ({ askGeminiOnTopic: vi.fn(async () => false) }));

const KEY = videoKey('abcdefghijk');
const store: Record<string, unknown> = {};
const sender = { tab: { id: 1 } } as chrome.runtime.MessageSender;
const ready = (title: string) =>
  handleVideoReady(sender, { videoId: 'abcdefghijk', durationSeconds: 3600, title, channel: 'Some Channel' });

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, {
    readingProgress: {}, pendingResume: {}, topicVerdicts: {},
    settings: { ...DEFAULT_SETTINGS, geminiTopicKey: 'k' },
  });
  const get = (keys: string | string[]) =>
    Promise.resolve(Object.fromEntries([keys].flat().map((k) => [k, structuredClone(store[k])])));
  const set = (o: Record<string, unknown>) => Promise.resolve(void Object.assign(store, o));
  vi.stubGlobal('chrome', { storage: { local: { get, set }, session: { get, set } } });
  vi.mocked(gateNewItem).mockClear();
});

describe('handleVideoReady topic gate', () => {
  it('off-topic video is not tracked', async () => {
    expect((await ready('Best pasta recipe')).track).toBe(false);
    expect(store.readingProgress).toEqual({});
  });

  it('on-topic video is tracked', async () => {
    expect((await ready('RL Course by David Silver - Lecture 1: Introduction to Reinforcement Learning')).track).toBe(true);
  });

  it('existing entry is never gated', async () => {
    store.readingProgress = { [KEY]: { kind: 'video', completedAt: null, positionSeconds: 0 } };
    expect((await ready('Best pasta recipe')).track).toBe(true);
    expect(gateNewItem).toHaveBeenCalledTimes(0);
  });

  it('empty topics track off-topic video', async () => {
    store.settings = { ...DEFAULT_SETTINGS, trackTopics: [], geminiTopicKey: 'k' };
    expect((await ready('Best pasta recipe')).track).toBe(true);
  });

  it('gates with the title and channel', async () => {
    await ready('(3) Best pasta recipe');
    expect(vi.mocked(gateNewItem).mock.calls[0].slice(0, 2)).toEqual([KEY, 'Best pasta recipe Some Channel']);
  });

  it('a video dropped by a late verdict is not recreated by its tracker', async () => {
    store.topicVerdicts = { [KEY]: false };
    await handleVideoProgress(sender, {
      videoId: 'abcdefghijk', positionSeconds: 60, durationSeconds: 3600, watchedSecondsDelta: 5,
      stopped: false, title: 'Best pasta recipe', channel: 'Some Channel',
    });
    expect(store.readingProgress).toEqual({});
  });
});
