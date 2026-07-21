import { describe, expect, it } from 'vitest';
import type { AssistantSkill } from '../types';
import { buildSkillBlock, selectSkills } from './skills';

function skill(overrides: Partial<AssistantSkill>): AssistantSkill {
  return {
    id: crypto.randomUUID(),
    name: 'Skill',
    keywords: [],
    body: 'Do the thing properly.',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('selectSkills', () => {
  const grocery = skill({
    name: 'Groceries',
    keywords: ['grocery', 'errand', 'task'],
    body: 'Grocery items go in the Errands context.',
  });
  const phrasing = skill({
    name: 'Task phrasing',
    keywords: ['task'],
    body: 'Tasks are always phrased as verbs.',
  });
  const unrelated = skill({
    name: 'Papers',
    keywords: ['paper', 'arxiv'],
    body: 'Papers get tagged by topic.',
  });

  it('picks skills whose keywords hit the utterance, best first', () => {
    const picked = selectSkills('add a task to buy grocery milk', 'add_task', [
      unrelated,
      phrasing,
      grocery,
    ]);
    expect(picked.map((s) => s.name)).toEqual(['Groceries', 'Task phrasing']);
  });

  it('returns nothing when no keyword applies', () => {
    expect(selectSkills('how many meetings today', null, [grocery, unrelated])).toEqual([]);
  });

  it('skips disabled skills and respects the budget', () => {
    const disabled = skill({ ...grocery, enabled: false });
    expect(selectSkills('add a grocery task', 'add_task', [disabled])).toEqual([]);

    const huge = skill({
      name: 'Huge',
      keywords: ['task'],
      body: 'x'.repeat(5000),
    });
    const picked = selectSkills('add a task', 'add_task', [huge, phrasing], 1200);
    expect(picked.map((s) => s.name)).toEqual(['Task phrasing']);
  });

  it('caps at two skills', () => {
    const third = skill({ name: 'Third', keywords: ['task'], body: 'Also this.' });
    expect(selectSkills('add a grocery task', 'add_task', [grocery, phrasing, third])).toHaveLength(2);
  });
});

describe('buildSkillBlock', () => {
  it('renders selected skills as an instruction block', () => {
    const block = buildSkillBlock([
      skill({ name: 'Groceries', body: 'Grocery items go in Errands.' }),
    ]);
    expect(block).toContain('User-written instructions (follow these):');
    expect(block).toContain('### Groceries');
    expect(block).toContain('Grocery items go in Errands.');
  });

  it('is empty for no skills', () => {
    expect(buildSkillBlock([])).toBe('');
  });
});
