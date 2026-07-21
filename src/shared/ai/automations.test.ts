import { describe, expect, it } from 'vitest';
import { AUTOMATION_MAX_PROPOSALS } from '../constants';
import { buildAutomationSchema, buildAutomationSystem, parseAutomationReply } from './automations';
import type { Tool } from './tools';

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

describe('buildAutomationSchema', () => {
  it('is digest-only without proposals (Nano path)', () => {
    const schema = buildAutomationSchema([addTask], false) as { properties: object };
    expect(Object.keys(schema.properties)).toEqual(['digest']);
  });

  it('caps proposals at the budget (cloud path)', () => {
    const schema = buildAutomationSchema([addTask], true) as {
      properties: { proposals: { maxItems: number } };
    };
    expect(schema.properties.proposals.maxItems).toBe(AUTOMATION_MAX_PROPOSALS);
  });
});

describe('buildAutomationSystem', () => {
  it('embeds the snapshot and any skill block', () => {
    const system = buildAutomationSystem('Open tasks: none.', '\n\nSKILLS');
    expect(system).toContain('Open tasks: none.');
    expect(system).toContain('SKILLS');
    expect(system).toContain('never propose actions the data does not support');
  });
});

describe('parseAutomationReply', () => {
  it('parses a digest with validated proposals', () => {
    const out = parseAutomationReply(
      '{"digest":"3 tasks open, oldest is 12 days.","proposals":[{"tool":"add_task","params":{"text":"triage inbox"}}]}',
      [addTask],
    );
    expect(out.digest).toBe('3 tasks open, oldest is 12 days.');
    expect(out.steps).toEqual([
      { name: 'add_task', params: { text: 'triage inbox' }, summary: 'Add task "triage inbox"' },
    ]);
  });

  it('discards invalid proposals instead of failing the run', () => {
    const out = parseAutomationReply(
      '{"digest":"Found things.","proposals":[{"tool":"launch_rocket","params":{}},{"tool":"add_task","params":{}}]}',
      [addTask],
    );
    // unknown tool discarded; add_task missing required text discarded
    expect(out.steps).toEqual([]);
    expect(out.digest).toBe('Found things.');
  });

  it('strips emoji from digests and rejects empty ones', () => {
    expect(parseAutomationReply('{"digest":"Done 🎉"}', [addTask]).digest).toBe('Done');
    expect(() => parseAutomationReply('{"digest":""}', [addTask])).toThrow('empty digest');
  });
});
