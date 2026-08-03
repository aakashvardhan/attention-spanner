import { describe, expect, it } from 'vitest';
import { MAX_PLAN_STEPS, NANO_INPUT_BUDGET_CHARS } from '../constants';
import {
  ASSISTANT_OVERLOADED_MESSAGE,
  buildPlanSchema,
  buildRouterSchema,
  buildRouterSystem,
  executePlan,
  extractivePageFallback,
  isTransientOverload,
  looksLikeLibraryQuestion,
  looksMultiStep,
  parseIntentResult,
  parseJsonObject,
  parsePlan,
  runAssistantTurn,
} from './assistant';
import type { AssistantProvider, GenerateRequest, ProviderReply } from './assistantTypes';
import { appendTurn, MAX_THREAD_TURNS, newTurn } from './assistantTypes';
import { cacheResetMemory } from './cache';
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

describe('isTransientOverload', () => {
  it('recognizes the provider overload message and a bare HTTP 503', () => {
    expect(
      isTransientOverload('Gemini is temporarily overloaded (HTTP 503) — try again in a moment.'),
    ).toBe(true);
    expect(isTransientOverload('upstream returned HTTP 503')).toBe(true);
    expect(isTransientOverload('TEMPORARILY OVERLOADED')).toBe(true);
  });

  it('does not flag unrelated failures a fallback cannot fix', () => {
    expect(isTransientOverload('The Gemini API key looks invalid — check Settings.')).toBe(false);
    expect(isTransientOverload('Gemini rate limit hit — wait a minute and try again.')).toBe(false);
    expect(isTransientOverload('')).toBe(false);
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

  it('drops tool turns — a loop scratchpad never reaches the session thread', () => {
    const thread = appendTurn(
      [newTurn('user', 'hi')],
      newTurn('tool', '4 highlights', { toolResult: { id: 'a', name: 'search_library', ok: true } }),
    );
    expect(thread).toHaveLength(1);
    expect(thread[0].text).toBe('hi');
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

  it('answers a repeated question from the cache with zero provider calls', async () => {
    cacheResetMemory();
    let calls = 0;
    const counting = (replies: string[]): AssistantProvider => {
      const inner = scriptedProvider(replies);
      return {
        ...inner,
        generate: (req) => {
          calls += 1;
          return inner.generate(req);
        },
      };
    };
    const makeDeps = () => ({
      nano: counting(['{"intent":"question","tool":null}', 'You have no tasks.']),
      tools: [fakeTool()],
      getContext: async () => 'Open tasks: none.',
      cache: true,
    });
    // "how many" hits the question heuristic (no router call), so the first
    // turn costs exactly one generate; the second turn costs zero.
    const first = await runAssistantTurn('how many tasks do I have?', [], makeDeps());
    expect(first).toMatchObject({ kind: 'reply' });
    const callsAfterFirst = calls;
    let streamed = '';
    const second = await runAssistantTurn('how many tasks do I have?', [], {
      ...makeDeps(),
      onToken: (t: string) => {
        streamed = t;
      },
    });
    expect(second).toEqual(first);
    expect(calls).toBe(callsAfterFirst);
    expect(streamed).toBe((first as { text: string }).text);
    cacheResetMemory();
  });

  it('skips provider probes when availability is injected', async () => {
    const provider = scriptedProvider(['{"intent":"chat","tool":null}', 'Short answer.']);
    const out = await runAssistantTurn('tell me something motivating', [], {
      nano: {
        ...provider,
        available: async () => {
          throw new Error('probe must not run');
        },
      },
      tools: [fakeTool()],
      availability: { nano: true, cloud: false },
    });
    expect(out.kind).toBe('reply');
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

  it('falls back to Nano when a long page cloud summary fails', async () => {
    let nanoSystem = '';
    const nano: AssistantProvider = {
      id: 'nano',
      available: async () => true,
      generate: async (req) => {
        if (req.responseSchema) return { text: '{"intent":"page","tool":"none"}' };
        nanoSystem = req.system;
        return { text: 'Local summary.' };
      },
    };
    const cloud: AssistantProvider = {
      id: 'gemini',
      available: async () => true,
      generate: async () => {
        throw new Error('Gemini is temporarily overloaded');
      },
    };
    const pageText = 'DeepMind robotics. '.repeat(800);
    const out = await runAssistantTurn('summarize this page', [], {
      nano,
      cloud,
      tools: [fakeTool()],
      getPage: async () => ({ title: 'Robotics', url: 'https://x.test', text: pageText }),
    });
    expect(out).toEqual({ kind: 'reply', text: 'Local summary.', source: 'nano' });
    expect(nanoSystem).toContain(pageText.slice(0, 1000));
    expect(nanoSystem).not.toContain(pageText);
    expect(nanoSystem.length + 'summarize this page'.length).toBeLessThanOrEqual(
      NANO_INPUT_BUDGET_CHARS,
    );
  });

  it('returns an extractive local summary when every page-summary provider fails', async () => {
    const cloud: AssistantProvider = {
      id: 'gemini',
      available: async () => true,
      generate: async (req) => {
        if (req.responseSchema) return { text: '{"intent":"page","tool":"none"}' };
        throw new Error('The Gemini API key looks invalid — check Settings.');
      },
    };
    const out = await runAssistantTurn('summarize this page', [], {
      nano: deadNano,
      cloud,
      tools: [fakeTool()],
      getPage: async () => ({ title: 'Frogs', url: 'https://x.test', text: 'Frogs are amphibians.' }),
    });
    expect(out).toEqual({
      kind: 'reply',
      source: 'local',
      text: '## Quick local summary\n\nFrogs are amphibians.',
    });
  });

  it('builds a short model-free fallback from substantial article sentences', () => {
    const text =
      'Gemini Robotics 2 introduces new capabilities for embodied reasoning. ' +
      'The system can understand complex instructions and adapt its behavior across different robots. ' +
      'DeepMind says the model combines perception, planning, and physical action in a single system. ' +
      'Cookie settings are available here.';
    const summary = extractivePageFallback({
      title: 'Gemini Robotics 2',
      url: 'https://deepmind.google/article',
      text,
    });
    expect(summary).toContain('## Quick local summary');
    expect(summary).toContain('Gemini Robotics 2 introduces');
    expect(summary).toContain('The system can understand complex instructions');
    expect(summary).not.toContain('Cookie settings');
  });

  it('deduplicates repeated excerpts in the model-free fallback', () => {
    const repeated =
      'The robot follows natural-language instructions while adapting to changes in its environment.';
    const summary = extractivePageFallback({
      title: 'Robotics',
      url: 'https://x.test',
      text: `${repeated} ${repeated} A second substantial sentence explains how the model transfers skills between different robot bodies.`,
    });
    expect(summary.match(/The robot follows/g)).toHaveLength(1);
    expect(summary).toContain('transfers skills');
  });

  it('bounds the raw excerpt when prose has no sentence boundaries', () => {
    const text = 'robotics '.repeat(100);
    const summary = extractivePageFallback({ title: 'Robotics', url: 'https://x.test', text });
    expect(summary).toContain('## Quick local summary');
    expect(summary.endsWith('…')).toBe(true);
    expect(summary.length).toBeLessThan(650);
  });

  it('uses the local extractive fallback for an empty successful model response', async () => {
    const cloud: AssistantProvider = {
      id: 'gemini',
      available: async () => true,
      generate: async (req) =>
        req.responseSchema ? { text: '{"intent":"page","tool":"none"}' } : { text: '   ' },
    };
    const out = await runAssistantTurn('summarize this page', [], {
      nano: deadNano,
      cloud,
      tools: [fakeTool()],
      getPage: async () => ({
        title: 'Robotics',
        url: 'https://x.test',
        text: 'This substantial article sentence explains how a robot reasons before taking a physical action.',
      }),
    });
    expect(out).toMatchObject({
      kind: 'reply',
      source: 'local',
      text: expect.stringContaining('robot reasons'),
    });
  });

  it('maps a screenshot-only overload to the friendly retry message', async () => {
    let imageCalls = 0;
    const cloud: AssistantProvider = {
      id: 'gemini',
      available: async () => true,
      generate: async (req) => {
        if (req.responseSchema) return { text: '{"intent":"page","tool":"none"}' };
        if (req.images?.length) imageCalls++;
        // The real provider throws friendlyHttpError(503) once its own retries
        // are exhausted — a screenshot-only turn has no text provider to fall
        // back to, so this is the message that reaches the user.
        throw new Error('Gemini is temporarily overloaded (HTTP 503) — try again in a moment.');
      },
    };
    const out = await runAssistantTurn('summarize this page', [], {
      nano: deadNano,
      cloud,
      tools: [fakeTool()],
      getPage: async () => null,
      getScreenshot: async () => ({ mimeType: 'image/jpeg', dataBase64: 'abc' }),
    });
    expect(out).toEqual({ kind: 'error', text: ASSISTANT_OVERLOADED_MESSAGE });
    expect(imageCalls).toBe(1);
  });

  it('still names a non-overload provider failure on a screenshot-only turn', async () => {
    const cloud: AssistantProvider = {
      id: 'gemini',
      available: async () => true,
      generate: async (req) => {
        if (req.responseSchema) return { text: '{"intent":"page","tool":"none"}' };
        throw new Error('The Gemini API key looks invalid — check Settings.');
      },
    };
    const out = await runAssistantTurn('what is on this slide?', [], {
      nano: deadNano,
      cloud,
      tools: [fakeTool()],
      getPage: async () => null,
      getScreenshot: async () => ({ mimeType: 'image/jpeg', dataBase64: 'abc' }),
    });
    expect(out).toEqual({
      kind: 'error',
      text: 'Reading the page failed: The Gemini API key looks invalid — check Settings.',
    });
  });

  it('answers a screenshot-only turn with Claude when Gemini is unavailable', async () => {
    let sawImage = false;
    const claude: AssistantProvider = {
      id: 'anthropic',
      available: async () => true,
      generate: async (req) => {
        if (req.responseSchema) return { text: '{"intent":"page","tool":"none"}' };
        if (req.images?.length) sawImage = true;
        return { text: 'The slide shows a robotics demo.' };
      },
    };
    const out = await runAssistantTurn('what is on this slide?', [], {
      nano: deadNano,
      cloud: claude,
      // Only the Claude key is configured, so Gemini is unavailable for vision.
      availability: { nano: false, cloud: true, anthropic: true, gemini: false },
      tools: [fakeTool()],
      getPage: async () => null,
      getScreenshot: async () => ({ mimeType: 'image/jpeg', dataBase64: 'abc' }),
    });
    expect(out).toEqual({
      kind: 'reply',
      text: 'The slide shows a robotics demo.',
      source: 'cloud',
    });
    expect(sawImage).toBe(true);
  });

  it('maps a plain-chat overload to the same friendly retry message', async () => {
    const cloud: AssistantProvider = {
      id: 'gemini',
      available: async () => true,
      generate: async (req) => {
        if (req.responseSchema) return { text: '{"intent":"chat","tool":"none"}' };
        throw new Error('Gemini is temporarily overloaded (HTTP 503) — try again in a moment.');
      },
    };
    const out = await runAssistantTurn('tell me a fun fact', [], {
      nano: deadNano,
      cloud,
      tools: [fakeTool()],
    });
    expect(out).toEqual({ kind: 'error', text: ASSISTANT_OVERLOADED_MESSAGE });
  });

  it('contains a rejected page extractor and returns the unreadable-tab guidance', async () => {
    const out = await runAssistantTurn('summarize this page', [], {
      nano: deadNano,
      cloud: cloudProvider(['{"intent":"page","tool":"none"}']),
      tools: [fakeTool()],
      getPage: async () => {
        throw new Error('tab navigated during extraction');
      },
      getScreenshot: false,
    });
    expect(out).toMatchObject({
      kind: 'reply',
      source: 'local',
      text: expect.stringContaining("can't read this tab"),
    });
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
    expect(run.text).toBe('Done: Added a\nDone: Added b');
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
    expect(run.text).toBe('Done: Added a\nFailed: boom\nSkipped: Add c');
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

describe('looksLikeLibraryQuestion', () => {
  it('fires on questions about the user’s own reading and notes', () => {
    expect(looksLikeLibraryQuestion('what did I highlight about attention?')).toBe(true);
    expect(looksLikeLibraryQuestion('find my note on streaks')).toBe(true);
    expect(looksLikeLibraryQuestion('what have I read on ADHD')).toBe(true);
    expect(looksLikeLibraryQuestion('anything I annotated last week?')).toBe(true);
  });

  it('stays out of the way for ordinary status questions', () => {
    expect(looksLikeLibraryQuestion('how is my streak doing?')).toBe(false);
    expect(looksLikeLibraryQuestion('how many tasks are open')).toBe(false);
    expect(looksLikeLibraryQuestion('start a 25 minute focus session')).toBe(false);
  });
});

/* The ReAct branch: how a finished loop maps onto the outcome kinds the
   surfaces already render. Providers here answer by inspecting the request,
   not by call order, so the loop is free to change how many calls it makes. */

describe('runAssistantTurn with react enabled', () => {
  const isLoop = (req: GenerateRequest) => !!req.tools?.length;

  function loopCloud(respond: (req: GenerateRequest) => ProviderReply): AssistantProvider {
    return {
      id: 'gemini',
      available: async () => true,
      generate: async (req) => respond(req),
    };
  }

  const reactDeps = (cloud: AssistantProvider, tools: Tool[]) => ({
    nano: scriptedProvider(['{"intent":"action","tool":"add_task"}']),
    cloud,
    tools,
    react: true,
    skills: [],
    getContext: async () => 'Open tasks: none.',
  });

  it('one staged mutation becomes a single confirm chip carrying the prose', async () => {
    const cloud = loopCloud((req) =>
      isLoop(req)
        ? req.turns.some((t) => t.role === 'tool')
          ? { text: 'Queued it.' }
          : {
              text: '',
              toolCalls: [{ id: 'a', name: 'add_task', params: { text: 'read the paper' } }],
            }
        : { text: '' },
    );
    const outcome = await runAssistantTurn('add a task to read the paper', [], reactDeps(cloud, [fakeTool()]));

    expect(outcome.kind).toBe('confirm');
    if (outcome.kind !== 'confirm') throw new Error('unreachable');
    expect(outcome.toolName).toBe('add_task');
    expect(outcome.params).toEqual({ text: 'read the paper' });
    expect(outcome.summary).toContain('Queued it.');
    expect(outcome.summary).toContain('Add task "read the paper"');
  });

  it('several staged mutations become one numbered confirm-plan', async () => {
    const second = fakeTool({ name: 'start_focus', params: { type: 'object', required: [], additionalProperties: false, properties: {} }, summary: () => 'Start a focus block' });
    const cloud = loopCloud((req) =>
      isLoop(req)
        ? req.turns.some((t) => t.role === 'tool')
          ? { text: 'Both queued.' }
          : {
              text: '',
              toolCalls: [
                { id: 'a', name: 'add_task', params: { text: 'ship it' } },
                { id: 'b', name: 'start_focus', params: {} },
              ],
            }
        : { text: '' },
    );
    const outcome = await runAssistantTurn('add a task and start a focus block', [], reactDeps(cloud, [fakeTool(), second]));

    expect(outcome.kind).toBe('confirm-plan');
    if (outcome.kind !== 'confirm-plan') throw new Error('unreachable');
    expect(outcome.steps.map((s) => s.name)).toEqual(['add_task', 'start_focus']);
    expect(outcome.summary).toContain('1. Add task "ship it"');
    expect(outcome.summary).toContain('2. Start a focus block');
  });

  it('a lookup with nothing staged is a plain reply', async () => {
    const readOnly = fakeTool({
      name: 'search_library',
      confirm: false,
      loop: 'auto',
      params: { type: 'object', required: [], additionalProperties: false, properties: {} },
      summary: () => 'Search the library',
      run: async () => 'four highlights about attention',
    });
    const cloud = loopCloud((req) =>
      isLoop(req)
        ? req.turns.some((t) => t.role === 'tool')
          ? { text: 'You highlighted four things about attention.' }
          : { text: '', toolCalls: [{ id: 'a', name: 'search_library', params: {} }] }
        : { text: '' },
    );
    const outcome = await runAssistantTurn('what did I highlight about attention', [], reactDeps(cloud, [readOnly]));

    expect(outcome).toMatchObject({
      kind: 'reply',
      text: 'You highlighted four things about attention.',
      source: 'cloud',
    });
    // The work reaches the surface, so the user can see what was consulted
    expect(outcome.kind === 'reply' && outcome.trace).toEqual([
      { n: 1, label: 'Search the library', status: 'done', detail: 'done', ms: expect.any(Number) },
    ]);
  });

  it('falls back to the legacy path when no cloud can drive a loop', async () => {
    // Nano-only: the loop declines, and the two-step JSON path handles it.
    const outcome = await runAssistantTurn('add a task to read the paper', [], {
      nano: scriptedProvider([
        '{"intent":"action","tool":"add_task"}',
        '{"text":"read the paper"}',
      ]),
      tools: [fakeTool()],
      react: true,
      skills: [],
      getContext: async () => 'Open tasks: none.',
    });
    expect(outcome.kind).toBe('confirm');
    if (outcome.kind !== 'confirm') throw new Error('unreachable');
    expect(outcome.params).toEqual({ text: 'read the paper' });
  });
});
