import { describe, expect, it } from 'vitest';
import { runAssistantTurn, relevantHistory } from './assistant';
import { newTurn, type AssistantProvider } from './assistantTypes';
import type { EvidenceBundle } from './evidence';

function evidence(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  const source = {
    id: 'S1',
    kind: 'task' as const,
    title: 'Open tasks',
    url: '',
    snippet: 'Open tasks: Email advisor',
    version: 'v1',
  };
  return {
    query: 'show my tasks',
    domains: ['tasks'],
    items: [{ source, text: 'Open tasks: Email advisor' }],
    context: '[S1] Open tasks: Email advisor',
    sources: [source],
    versionHash: 'abc',
    complete: true,
    ...overrides,
  };
}

describe('dashboard fast assistant path', () => {
  it('returns an exact grounded answer without a provider generation', async () => {
    let generations = 0;
    const nano: AssistantProvider = {
      id: 'nano',
      available: async () => true,
      generate: async () => {
        generations += 1;
        return { text: 'should not run' };
      },
    };
    const phases: string[] = [];
    const out = await runAssistantTurn('how many open tasks do I have?', [], {
      nano,
      tools: [],
      skills: [],
      availability: { nano: true, cloud: false },
      getEvidence: async () => evidence({ exactAnswer: 'You have 1 open task.' }),
      onPhase: (phase) => phases.push(phase),
    });

    expect(generations).toBe(0);
    expect(out).toMatchObject({
      kind: 'reply',
      text: 'You have 1 open task.',
      source: 'local',
      grounding: 'grounded',
      sources: [{ id: 'S1' }],
    });
    expect(phases).toEqual(['routing', 'retrieving']);
  });

  it('streams one synthesis call over the retrieved evidence', async () => {
    let system = '';
    const nano: AssistantProvider = {
      id: 'nano',
      available: async () => true,
      generate: async (req) => {
        system = req.system;
        req.onToken?.('Email');
        return { text: 'Email your advisor [S1].' };
      },
    };
    let partial = '';
    const out = await runAssistantTurn('show my tasks', [], {
      nano,
      tools: [],
      skills: [],
      availability: { nano: true, cloud: false },
      getEvidence: async () => evidence(),
      onToken: (text) => {
        partial = text;
      },
    });

    expect(system).toContain('ONLY the evidence');
    expect(system).toContain('[S1] Open tasks: Email advisor');
    expect(partial).toBe('Email');
    expect(out).toMatchObject({ kind: 'reply', grounding: 'grounded' });
    expect(out.kind === 'reply' && out.text).toContain('Email your advisor [S1].');
  });

  it('refuses to synthesize when a selected domain has no evidence', async () => {
    const nano: AssistantProvider = {
      id: 'nano',
      available: async () => true,
      generate: async () => {
        throw new Error('must not generate');
      },
    };
    const out = await runAssistantTurn('what did I highlight about transformers?', [], {
      nano,
      tools: [],
      skills: [],
      availability: { nano: true, cloud: false },
      getEvidence: async () =>
        evidence({
          domains: ['library'],
          items: [],
          context: '',
          sources: [],
          complete: false,
          versionHash: 'empty',
        }),
    });
    expect(out).toMatchObject({ kind: 'reply', source: 'local', grounding: 'insufficient' });
  });

  it('falls back to Nano after the preferred cloud stays overloaded', async () => {
    let cloudCalls = 0;
    const cloud: AssistantProvider = {
      id: 'gemini',
      available: async () => true,
      generate: async () => {
        cloudCalls += 1;
        throw new Error('Gemini is temporarily overloaded (HTTP 503)');
      },
    };
    const nano: AssistantProvider = {
      id: 'nano',
      available: async () => true,
      generate: async () => ({ text: 'Email your advisor [S1].' }),
    };
    const out = await runAssistantTurn('show my tasks', [], {
      nano,
      cloud,
      tools: [],
      skills: [],
      availability: { nano: true, cloud: true, gemini: true },
      preferCloudForAnswers: true,
      getEvidence: async () => evidence(),
    });

    expect(cloudCalls).toBe(1);
    expect(out).toMatchObject({
      kind: 'reply',
      source: 'nano',
      text: 'Email your advisor [S1].',
      grounding: 'grounded',
    });
  });
});

describe('relevantHistory', () => {
  it('keeps recent turns and retrieves an older entity-matching turn', () => {
    const older = newTurn('user', 'My advisor prefers Friday meetings');
    const filler = Array.from({ length: 8 }, (_, i) => newTurn('assistant', `unrelated ${i}`));
    const selected = relevantHistory([older, ...filler], 'What did we decide about my advisor?');

    expect(selected).toContain(older);
    expect(selected.slice(-6)).toEqual(filler.slice(-6));
    expect(selected.length).toBe(7);
  });
});
