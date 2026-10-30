import { describe, expect, it } from 'vitest';
import { DEFAULT_TOPICS, keywordOnTopic, normalizeTrackTopics } from './topics';

describe('keywordOnTopic', () => {
  it("default topics keep the screenshot's titles", () => {
    for (const t of [
      'Learning Fine-Grained Bimanual Manipulation with Low-Cost Hardware',
      'Proximal Policy Optimization Algorithms',
      'Playing Atari with Deep Reinforcement Learning',
      'RL Course by David Silver - Lecture 1: Introduction to Reinforcement Learning',
      'V-JEPA 2: Self-Supervised Video Models Enable Understanding, Prediction and Planning',
    ]) expect(keywordOnTopic(t, DEFAULT_TOPICS), t).toBe(true);
  });

  it('default topics drop the obvious misses', () => {
    for (const t of [
      'Focus workspace',
      'Lofi hip hop radio - beats to relax/study to',
      'Best pasta recipe in 10 minutes',
      'Wasmer (YC S19) Is Hiring OS/Hypervisor Experts in Europe',
    ]) expect(keywordOnTopic(t, DEFAULT_TOPICS), t).toBe(false);
  });

  it('empty topics match everything', () => {
    expect(keywordOnTopic('Best pasta recipe', [])).toBe(true);
  });

  it('custom topic whole words', () => {
    expect(keywordOnTopic('Intro to Quantum Computing', ['quantum computing'])).toBe(true);
    expect(keywordOnTopic('quantumcomputingly', ['quantum computing'])).toBe(false);
  });

  it('catches ChatGPT, language models, RLHF and bandits', () => {
    for (const t of ['ChatGPT tips', 'Large Language Models explained', 'RLHF from scratch', 'Multi-armed bandits'])
      expect(keywordOnTopic(t, DEFAULT_TOPICS), t).toBe(true);
  });

  it('RL needs a word boundary', () => {
    expect(keywordOnTopic('Girl talk', DEFAULT_TOPICS)).toBe(false);
  });
});

describe('normalizeTrackTopics', () => {
  it('trims and de-duplicates case-insensitively', () => {
    expect(normalizeTrackTopics([' AI ', 'ai', ''])).toEqual(['AI']);
  });
  it('non-array falls back to the defaults', () => {
    expect(normalizeTrackTopics('nope')).toEqual(DEFAULT_TOPICS);
  });
  it('caps at 20 topics and 40 chars each', () => {
    expect(normalizeTrackTopics(Array.from({ length: 25 }, (_, i) => `t${i}`))).toHaveLength(20);
    expect(normalizeTrackTopics(['x'.repeat(50)])).toEqual(['x'.repeat(40)]);
  });
});
