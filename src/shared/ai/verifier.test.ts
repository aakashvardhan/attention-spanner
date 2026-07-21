import { describe, expect, it } from 'vitest';
import type { PlannedStep } from './assistant';
import type { AssistantProvider } from './assistantTypes';
import type { Tool } from './tools';
import { buildCriticSchema, parseCriticReply, verifyPlan } from './verifier';

const addTask: Tool = {
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
};

const steps: PlannedStep[] = [
  { name: 'add_task', params: { text: 'a' }, summary: 'Add task "a"' },
  { name: 'add_task', params: { text: 'b' }, summary: 'Add task "b"' },
];

function provider(reply: string | Error): AssistantProvider {
  return {
    id: 'gemini',
    available: async () => true,
    generate: async () => {
      if (reply instanceof Error) throw reply;
      return { text: reply };
    },
  };
}

describe('parseCriticReply', () => {
  it('parses an ok verdict', () => {
    expect(parseCriticReply('{"verdict":"ok","issues":[]}', [addTask])).toEqual({
      verdict: 'ok',
      issues: [],
      steps: null,
    });
  });

  it('parses a revise verdict with validated steps', () => {
    const out = parseCriticReply(
      '{"verdict":"revise","issues":["task a already exists"],"steps":[{"tool":"add_task","params":{"text":"b"}}]}',
      [addTask],
    );
    expect(out.verdict).toBe('revise');
    expect(out.issues).toEqual(['task a already exists']);
    expect(out.steps).toEqual([
      { name: 'add_task', params: { text: 'b' }, summary: 'Add task "b"' },
    ]);
  });

  it('throws when revised steps use unknown tools', () => {
    expect(() =>
      parseCriticReply(
        '{"verdict":"revise","issues":[],"steps":[{"tool":"launch_rocket","params":{}}]}',
        [addTask],
      ),
    ).toThrow('unknown tool');
  });
});

describe('buildCriticSchema', () => {
  it('embeds the plan-steps schema and the verdict enum', () => {
    const schema = buildCriticSchema([addTask]) as {
      properties: { verdict: { enum: string[] }; steps: object };
    };
    expect(schema.properties.verdict.enum).toEqual(['ok', 'revise']);
    expect(schema.properties.steps).toBeDefined();
  });
});

describe('verifyPlan', () => {
  const getContext = async () => 'Open tasks: “a”.';

  it('returns no changes on an ok verdict', async () => {
    const out = await verifyPlan('add a and b', steps, [addTask], provider('{"verdict":"ok","issues":[]}'), getContext);
    expect(out).toEqual({ steps: null, issues: [] });
  });

  it('returns revised steps and issues on revise', async () => {
    const out = await verifyPlan(
      'add a and b',
      steps,
      [addTask],
      provider(
        '{"verdict":"revise","issues":["task a already exists"],"steps":[{"tool":"add_task","params":{"text":"b"}}]}',
      ),
      getContext,
    );
    expect(out.issues).toEqual(['task a already exists']);
    expect(out.steps).toHaveLength(1);
  });

  it('never blocks: provider failure falls through to the original plan', async () => {
    const out = await verifyPlan('add a and b', steps, [addTask], provider(new Error('boom')), getContext);
    expect(out).toEqual({ steps: null, issues: [] });
  });

  it('never blocks: junk critic output falls through too', async () => {
    const out = await verifyPlan('add a and b', steps, [addTask], provider('not json'), getContext);
    expect(out).toEqual({ steps: null, issues: [] });
  });
});
