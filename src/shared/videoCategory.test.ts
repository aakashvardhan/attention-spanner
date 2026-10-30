import { describe, expect, it } from 'vitest';
import { groupByCategory, videoCategory } from './videoCategory';
import { cleanVideoTitle } from './youtube';

describe('videoCategory', () => {
  it('files a numbered lecture under Lecture series before its topic', () => {
    expect(videoCategory('RL Course by David Silver - Lecture 1: Introduction to Reinforcement Learning', 'Google DeepMind')).toBe('Lecture series');
    expect(videoCategory('Stanford CS224N | Lecture 5 - Recurrent Neural Networks', 'Stanford Online')).toBe('Lecture series');
  });

  it('reads the topic from the title, then the channel', () => {
    expect(videoCategory('Teaching a humanoid to fold laundry', 'Physical Intelligence')).toBe('Robotics');
    expect(videoCategory('How LLMs actually work', 'Some Channel')).toBe('AI');
    expect(videoCategory('Weekly update', 'Google DeepMind')).toBe('AI');
    expect(videoCategory('Rust ownership in 10 minutes', 'Dev Channel')).toBe('Programming');
    expect(videoCategory('The essence of linear algebra', '3Blue1Brown')).toBe('Math & science');
    expect(videoCategory('Best pasta recipe', 'Cooking')).toBe('Other');
  });

  it('does not mistake words that merely contain a keyword', () => {
    expect(videoCategory('Said the painter', 'Art')).toBe('Other');
    expect(videoCategory('Main street drone footage', 'Travel')).toBe('Robotics');
  });
});

describe('groupByCategory', () => {
  it('keeps the newest-first order inside and across groups', () => {
    const vids = [
      { title: 'Lecture 2 of the course', source: '' },
      { title: 'Robot arm demo', source: '' },
      { title: 'Lecture 3 of the course', source: '' },
    ];
    expect(groupByCategory(vids, (v) => [v.title, v.source]).map(([c, v]) => [c, v.map((x) => x.title)])).toEqual([
      ['Lecture series', ['Lecture 2 of the course', 'Lecture 3 of the course']],
      ['Robotics', ['Robot arm demo']],
    ]);
  });
});

describe('cleanVideoTitle', () => {
  it("drops YouTube's notification count from the tab title", () => {
    expect(cleanVideoTitle('(37) RL Course by David Silver')).toBe('RL Course by David Silver');
    expect(cleanVideoTitle('(2021) Retrospective')).toBe('(2021) Retrospective');
  });
});
