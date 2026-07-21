import { describe, expect, it } from 'vitest';
import { heuristicRoute } from './heuristics';
import { TOOLS } from './tools';

describe('heuristicRoute', () => {
  it('routes obvious command prefixes to their tool', () => {
    expect(heuristicRoute('add a task buy milk', TOOLS)).toEqual({
      intent: 'action',
      tool: 'add_task',
    });
    expect(heuristicRoute('Remember I park on level 3', TOOLS)).toEqual({
      intent: 'action',
      tool: 'remember',
    });
    expect(heuristicRoute('start a pomodoro', TOOLS)).toEqual({
      intent: 'action',
      tool: 'start_focus',
    });
    expect(heuristicRoute('open my dashboard', TOOLS)).toEqual({
      intent: 'action',
      tool: 'open_page',
    });
  });

  it('routes question shapes to question intent', () => {
    expect(heuristicRoute('how many tasks do I have?', TOOLS)).toEqual({
      intent: 'question',
      tool: null,
    });
    expect(heuristicRoute("What's my streak", TOOLS)).toEqual({
      intent: 'question',
      tool: null,
    });
    expect(heuristicRoute('do I have any meetings today', TOOLS)).toEqual({
      intent: 'question',
      tool: null,
    });
  });

  it('abstains when unsure', () => {
    expect(heuristicRoute('tell me something motivating', TOOLS)).toBeNull();
    expect(heuristicRoute('summarize this page', TOOLS)).toBeNull();
    expect(heuristicRoute('', TOOLS)).toBeNull();
  });

  it('abstains on chained commands so the planner can route them', () => {
    expect(heuristicRoute('add a task buy milk and then start a focus session', TOOLS)).toBeNull();
  });

  it('never picks a tool missing from the active registry', () => {
    expect(heuristicRoute('add a task buy milk', [])).toBeNull();
  });
});
