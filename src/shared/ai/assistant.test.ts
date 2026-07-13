import { describe, expect, it } from 'vitest';
import { MAX_PLAN_STEPS } from '../constants';
import {
  buildPlanSchema,
  buildRouterSchema,
  buildRouterSystem,
  executePlan,
  looksMultiStep,
  parseIntentResult,
  parseJsonObject,
  parsePlan,
  runAssistantTurn,
} from './assistant';
import type { AssistantProvider, GenerateRequest } from './assistantTypes';
import { appendTurn, MAX_THREAD_TURNS, newTurn } from './assistantTypes';
import { TOOLS, type Tool } from './tools';

const TOOL_NAMES = ['add_task', 'start_focus'];

describe('parseJsonObject', () => {
  it('parses plain JSON and fenced JSON', () => {
    expect(parseJsonObject('{"a": 1}')).toEqual({ a: 1 });
    expect(parseJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it('throws on junk and non-objects', () => {
    expect(() => parseJsonObject('not json')).toThrow('invalid JSON');
    expect(() => parseJsonObject('[1,2]')).toThrow('non-object');
    expect(() => parseJsonObject('null')).toThrow('non-object');
  });
});

describe('parseIntentResult', () => {
  it('parses a valid routing', () => {
    expect(parseIntentResult('{"intent":"action","tool":"add_task"}', TOOL_NAMES)).toEqual({
      intent: 'action',
      tool: 'add_task',
    });
  });

  it('falls back to chat on invalid intent or junk', () => {
    expect(parseIntentResult('{"intent":"dance","tool":"none"}', TOOL_NAMES).intent).toBe('chat');
    expect(parseIntentResult('garbage', TOOL_NAMES)).toEqual({ intent: 'chat', tool: null });
  });

  it('nulls unknown tools', () => {
    expect(parseIntentResult('{"intent":"action","tool":"launch_rocket"}', TOOL_NAMES).tool).toBeNull();
    expect(parseIntentResult('{"intent":"action","tool":"none"}', TOOL_NAMES).tool).toBeNull();
  });
});

describe('appendTurn', () => {
  it('appends and caps the thread', () => {
    let thread = Array.from({ length: MAX_THREAD_TURNS }, (_, i) => newTurn('user', `t${i}`));
    thread = appendTurn(thread, newTurn('assistant', 'newest'));
    expect(thread).toHaveLength(MAX_THREAD_TURNS);
    expect(thread[thread.length - 1].text).toBe('newest');
    expect(thread[0].text).toBe('t1');
  });
});

/* Orchestrator flow with a scripted fake provider */

function fakeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'add_task',
    description: 'Add a task',
    params: {
      type: 'object',
      required: ['text'],
      additionalProperties: false,
      properties: { text: { type: 'string', description: 'task text' } },
    },
    confirm: true,
    summary: (p) => `Add task "${(p.text as string) ?? ''}"`,
    run: async (p) => `Added ${p.text as string}`,
    ...overrides,
  };
}

function scriptedProvider(replies: string[]): AssistantProvider {
  let i = 0;
  return {
    id: 'nano',
    available: async () => true,
    generate: async (req: GenerateRequest) => {
      const text = replies[Math.min(i++, replies.length - 1)];
      req.onToken?.(text);
      return { text };
    },
  };
}

describe('runAssistantTurn', () => {
  const deps = (replies: string[], tools: Tool[]) => ({
    nano: scriptedProvider(replies),
    tools,
    getContext: async () => 'Open tasks: none.',
  });

  it('routes an action to a confirm outcome with extracted params', async () => {
    const out = await runAssistantTurn(
      'add a task to email my advisor',
      [],
      deps(
        ['{"intent":"action","tool":"add_task"}', '{"text":"Email my advisor"}'],
        [fakeTool()],
      ),
    );
    expect(out).toEqual({
      kind: 'confirm',
      toolName: 'add_task',
      params: { text: 'Email my advisor' },
      summary: 'Add task "Email my advisor"',
    });
  });

  it('runs non-confirm tools immediately', async () => {
    const tool = fakeTool({ confirm: false });
    const out = await runAssistantTurn(
      'add a task to email my advisor',
      [],
      deps(['{"intent":"action","tool":"add_task"}', '{"text":"Email"}'], [tool]),
    );
    expect(out).toEqual({ kind: 'done', text: 'Added Email' });
  });

  it('gives up after two failed extractions', async () => {
    const out = await runAssistantTurn(
      'add a task',
      [],
      deps(['{"intent":"action","tool":"add_task"}', 'junk', 'more junk'], [fakeTool()]),
    );
    expect(out.kind).toBe('error');
  });

  it('answers questions with the data context', async () => {
    let seenSystem = '';
    const provider: AssistantProvider = {
      id: 'nano',
      available: async () => true,
      generate: async (req) => {
        seenSystem = req.system;
        return { text: req.responseSchema ? '{"intent":"question","tool":"none"}' : 'You have no tasks.' };
      },
    };
    const out = await runAssistantTurn('how many tasks do I have?', [], {
      nano: provider,
      tools: [fakeTool()],
      getContext: async () => 'Open tasks: none.',
    });
    expect(out).toEqual({ kind: 'reply', text: 'You have no tasks.', source: 'nano' });
    expect(seenSystem).toContain('Open tasks: none.');
  });

  it('degrades to chat when the router returns junk', async () => {
    const out = await runAssistantTurn(
      'hello there',
      [],
      deps(['total garbage', 'Hi! How can I help?'], [fakeTool()]),
    );
    expect(out).toMatchObject({ kind: 'reply', source: 'nano' });
  });

  it('errors politely when no provider is available', async () => {
    const provider: AssistantProvider = {
      id: 'nano',
      available: async () => false,
      generate: async () => ({ text: '' }),
    };
    const out = await runAssistantTurn('hi', [], { nano: provider, tools: [fakeTool()] });
    expect(out.kind).toBe('error');
  });
});

describe('cloud escalation and page-aware help', () => {
  const deadNano: AssistantProvider = {
    id: 'nano',
    available: async () => false,
    generate: async () => {
      throw new Error('nano should not be called');
    },
  };

  function cloudProvider(replies: string[]): AssistantProvider {
    let i = 0;
    return {
      id: 'gemini',
      available: async () => true,
      generate: async (req) => {
        const text = replies[Math.min(i++, replies.length - 1)];
        req.onToken?.(text);
        return { text };
      },
    };
  }

  it('falls back to cloud when nano is unavailable', async () => {
    const out = await runAssistantTurn('hello', [], {
      nano: deadNano,
      cloud: cloudProvider(['{"intent":"chat","tool":"none"}', 'Hi from the cloud!']),
      tools: [fakeTool()],
    });
    expect(out).toEqual({ kind: 'reply', text: 'Hi from the cloud!', source: 'cloud' });
  });

  it('answers page questions with the extracted page in the system prompt', async () => {
    let seenSystem = '';
    const cloud: AssistantProvider = {
      id: 'gemini',
      available: async () => true,
      generate: async (req) => {
        if (req.responseSchema) return { text: '{"intent":"page","tool":"none"}' };
        seenSystem = req.system;
        return { text: 'It is about frogs.' };
      },
    };
    const out = await runAssistantTurn('summarize this page', [], {
      nano: deadNano,
      cloud,
      tools: [fakeTool()],
      getPage: async () => ({ title: 'Frogs', url: 'https://x.test', text: 'Frogs are amphibians.' }),
    });
    expect(out).toEqual({ kind: 'reply', text: 'It is about frogs.', source: 'cloud' });
    expect(seenSystem).toContain('Frogs are amphibians.');
  });

  it('turns a page into a save_flashcards confirm', async () => {
    const cloud: AssistantProvider = {
      id: 'gemini',
      available: async () => true,
      generate: async (req) =>
        req.responseSchema && JSON.stringify(req.responseSchema).includes('cards')
          ? { text: '{"cards":[{"front":"Q1","back":"A1"},{"front":"Q2","back":"A2"}]}' }
          : { text: '{"intent":"page","tool":"none"}' },
    };
    const out = await runAssistantTurn('make flashcards from this page', [], {
      nano: deadNano,
      cloud,
      tools: [fakeTool()],
      getPage: async () => ({ title: 'Frogs', url: 'https://x.test', text: 'Frogs are amphibians.' }),
    });
    expect(out).toMatchObject({
      kind: 'confirm',
      toolName: 'save_flashcards',
      params: { cards: [{ front: 'Q1', back: 'A1' }, { front: 'Q2', back: 'A2' }] },
    });
  });

  it('replies locally when the page is unreadable', async () => {
    const out = await runAssistantTurn('summarize this page', [], {
      nano: deadNano,
      cloud: cloudProvider(['{"intent":"page","tool":"none"}']),
      tools: [fakeTool()],
      getPage: async () => null,
    });
    expect(out).toMatchObject({ kind: 'reply', source: 'local' });
  });
});

describe('looksMultiStep', () => {
  it('catches connective wording and counted lists', () => {
    expect(looksMultiStep('add a task to buy milk and start a focus session')).toBe(true);
    expect(looksMultiStep('refresh feeds then mark everything read')).toBe(true);
    expect(looksMultiStep('add 3 tasks: milk, eggs, bread')).toBe(true);
  });

  it('leaves plain single requests alone', () => {
    expect(looksMultiStep('start a focus session')).toBe(false);
    expect(looksMultiStep('snooze the dentist task')).toBe(false);
  });
});

describe('buildPlanSchema / parsePlan', () => {
  const tools = [
    fakeTool(),
    fakeTool({
      name: 'start_focus',
      description: 'Start focus',
      params: {
        type: 'object',
        required: [],
        additionalProperties: false,
        properties: { minutes: { type: 'number', description: 'length', minimum: 5, maximum: 240 } },
      },
      summary: (p) => `Start ${(p.minutes as number) ?? '?'}-min focus`,
      run: async () => 'Focus started',
    }),
  ];

  it('merges every tool param (constraints dropped) and enums the tool names', () => {
    const schema = buildPlanSchema(tools) as {
      properties: {
        steps: {
          maxItems: number;
          items: { properties: { tool: { enum: string[] }; params: { properties: Record<string, { minimum?: number }> } } };
        };
      };
    };
    expect(schema.properties.steps.maxItems).toBe(MAX_PLAN_STEPS);
    expect(schema.properties.steps.items.properties.tool.enum).toEqual(['add_task', 'start_focus']);
    expect(Object.keys(schema.properties.steps.items.properties.params.properties)).toEqual([
      'text',
      'minutes',
    ]);
    expect(schema.properties.steps.items.properties.params.properties.minutes.minimum).toBeUndefined();
  });

  it('no same-named param has conflicting types across the real registry', () => {
    const seen = new Map<string, string>();
    for (const tool of TOOLS) {
      for (const [key, spec] of Object.entries(tool.params.properties)) {
        const prior = seen.get(key);
        if (prior) expect(`${key}:${spec.type}`).toBe(`${key}:${prior}`);
        else seen.set(key, spec.type);
      }
    }
  });

  it('parses a valid plan into validated steps with summaries', () => {
    const steps = parsePlan(
      '{"steps":[{"tool":"add_task","params":{"text":"Buy milk"}},{"tool":"start_focus","params":{"minutes":"25"}}]}',
      tools,
    );
    expect(steps).toEqual([
      { name: 'add_task', params: { text: 'Buy milk' }, summary: 'Add task "Buy milk"' },
      { name: 'start_focus', params: { minutes: 25 }, summary: 'Start 25-min focus' },
    ]);
  });

  it('throws on unknown tools, invalid steps, and empty plans', () => {
    expect(() => parsePlan('{"steps":[{"tool":"launch_rocket","params":{}}]}', tools)).toThrow('unknown tool');
    expect(() => parsePlan('{"steps":[{"tool":"add_task","params":{}}]}', tools)).toThrow('missing required');
    expect(() => parsePlan('{"steps":[]}', tools)).toThrow('empty plan');
  });
});

describe('executePlan', () => {
  const okTool = fakeTool({ confirm: false });
  const bombTool = fakeTool({
    name: 'start_focus',
    params: { type: 'object', required: [], additionalProperties: false, properties: {} },
    summary: () => 'Start focus',
    run: async () => {
      throw new Error('boom');
    },
  });

  it('runs steps in order and reports each result', async () => {
    const run = await executePlan(
      [
        { name: 'add_task', params: { text: 'a' }, summary: 'Add a' },
        { name: 'add_task', params: { text: 'b' }, summary: 'Add b' },
      ],
      [okTool],
    );
    expect(run.ok).toBe(true);
    expect(run.text).toBe('✓ Added a\n✓ Added b');
  });

  it('stops at the first failure and marks the rest skipped', async () => {
    const seen: string[] = [];
    const run = await executePlan(
      [
        { name: 'add_task', params: { text: 'a' }, summary: 'Add a' },
        { name: 'start_focus', params: {}, summary: 'Start focus' },
        { name: 'add_task', params: { text: 'c' }, summary: 'Add c' },
      ],
      [okTool, bombTool],
      (i, outcome) => {
        seen.push(`${i}:${outcome.status}`);
      },
    );
    expect(run.ok).toBe(false);
    expect(run.text).toBe('✓ Added a\n✗ boom\n– Skipped: Add c');
    expect(seen).toEqual(['0:done', '1:failed', '2:skipped']);
  });
});

describe('multi-step planning in runAssistantTurn', () => {
  const nano = (replies: string[]) => scriptedProvider(replies);

  function planCloud(planJson: string): AssistantProvider {
    return {
      id: 'gemini',
      available: async () => true,
      generate: async (req) => {
        if (req.responseSchema && JSON.stringify(req.responseSchema).includes('steps')) {
          return { text: planJson };
        }
        throw new Error('cloud only expected the plan call');
      },
    };
  }

  const focusTool = fakeTool({
    name: 'start_focus',
    description: 'Start focus',
    params: {
      type: 'object',
      required: [],
      additionalProperties: false,
      properties: { minutes: { type: 'number', description: 'length' } },
    },
    summary: (p) => `Start ${(p.minutes as number) ?? '?'}-min focus`,
    run: async () => 'Focus started',
  });

  it('returns confirm-plan for a multi-step request with mutating steps', async () => {
    const out = await runAssistantTurn('add a task to buy milk and start a 25 minute focus', [], {
      nano: nano(['{"intent":"action","tool":"add_task"}']),
      cloud: planCloud(
        '{"steps":[{"tool":"add_task","params":{"text":"Buy milk"}},{"tool":"start_focus","params":{"minutes":25}}]}',
      ),
      tools: [fakeTool(), focusTool],
    });
    expect(out).toMatchObject({
      kind: 'confirm-plan',
      steps: [
        { name: 'add_task', params: { text: 'Buy milk' } },
        { name: 'start_focus', params: { minutes: 25 } },
      ],
    });
  });

  it('reduces a one-step plan to the ordinary confirm outcome', async () => {
    const out = await runAssistantTurn('add a task to buy milk and eggs', [], {
      nano: nano(['{"intent":"action","tool":"add_task"}']),
      cloud: planCloud('{"steps":[{"tool":"add_task","params":{"text":"Buy milk and eggs"}}]}'),
      tools: [fakeTool(), focusTool],
    });
    expect(out).toEqual({
      kind: 'confirm',
      toolName: 'add_task',
      params: { text: 'Buy milk and eggs' },
      summary: 'Add task "Buy milk and eggs"',
    });
  });

  it('falls back to single-tool extraction when the plan is invalid', async () => {
    const out = await runAssistantTurn('add a task to buy milk and start focus', [], {
      nano: nano(['{"intent":"action","tool":"add_task"}', '{"text":"Buy milk"}']),
      cloud: planCloud('{"steps":[{"tool":"launch_rocket","params":{}}]}'),
      tools: [fakeTool(), focusTool],
    });
    expect(out).toMatchObject({ kind: 'confirm', toolName: 'add_task', params: { text: 'Buy milk' } });
  });

  it('never plans when multiStep is false', async () => {
    const out = await runAssistantTurn('add a task to buy milk and start focus', [], {
      nano: nano(['{"intent":"action","tool":"add_task"}', '{"text":"Buy milk"}']),
      cloud: planCloud('{"steps":[{"tool":"add_task","params":{"text":"WRONG PATH"}}]}'),
      tools: [fakeTool(), focusTool],
      multiStep: false,
    });
    expect(out).toMatchObject({ kind: 'confirm', params: { text: 'Buy milk' } });
  });
});

describe('router prompt builders', () => {
  it('lists every tool in the system prompt and schema enum', () => {
    const tools = [fakeTool(), fakeTool({ name: 'start_focus', description: 'Start focus' })];
    const system = buildRouterSystem(tools);
    expect(system).toContain('add_task');
    expect(system).toContain('start_focus');
    const schema = buildRouterSchema(tools) as {
      properties: { tool: { enum: string[] } };
    };
    expect(schema.properties.tool.enum).toEqual(['add_task', 'start_focus', 'none']);
  });
});
