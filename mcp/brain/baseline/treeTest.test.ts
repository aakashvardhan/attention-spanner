import { describe, expect, it } from 'vitest';
import type { Io } from '../args';
import { parseTree, parseTreeTasks, runTreeTask, summarizeTree } from './treeTest';

const MAP = '- School\n  - DL Class\n  - DATA 220\n- Research/\n  - Meetings\n';

describe('parseTree', () => {
  it('reads a nested list into folders', () => {
    const t = parseTree(MAP);
    expect(t.children.map((c) => c.name)).toEqual(['School', 'Research']);
    expect(t.children[0].children.map((c) => c.name)).toEqual(['DL Class', 'DATA 220']);
  });
  it('refuses an empty map', () => {
    expect(() => parseTree('# nothing')).toThrow(/no folders/);
  });
});

describe('parseTreeTasks', () => {
  it('reads tasks with one or more accepted answers', () => {
    const md = Array.from({ length: 15 }, (_, i) => `${i + 1}. Find thing ${i} => School/DL Class | Research`).join('\n');
    const tasks = parseTreeTasks(md);
    expect(tasks).toHaveLength(15);
    expect(tasks[0]).toEqual({ text: 'Find thing 0', answers: ['School/DL Class', 'Research'] });
    expect(() => parseTreeTasks('1. Only one => School')).toThrow(/exactly 15/);
  });
});

describe('runTreeTask', () => {
  const io = (answers: string[]): Io => ({ ask: async () => answers.shift() ?? 'h', say: () => {}, now: () => 0 });
  it('records the folder chosen and whether the user went back up', async () => {
    const root = parseTree(MAP);
    expect(await runTreeTask(root, io(['1', '2', 'h']))).toEqual({ path: 'School/DATA 220', backtracked: false });
    expect(await runTreeTask(root, io(['2', '0', '1', '1', 'h']))).toEqual({ path: 'School/DL Class', backtracked: true });
  });
  it('ignores input it does not understand', async () => {
    expect(await runTreeTask(parseTree(MAP), io(['9', 'zzz', '1', 'h']))).toEqual({ path: 'School', backtracked: false });
  });
});

describe('summarizeTree', () => {
  it('counts directness over all tasks', () => {
    expect(summarizeTree([{ success: true, direct: true }, { success: true, direct: false }, { success: false, direct: false }, { success: true, direct: true }])).toEqual({
      n: 4,
      success: 0.75,
      directness: 0.5,
    });
  });
});
