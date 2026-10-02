import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_MODELS } from '../constants';
import { claudeStream } from './claude';

const sent: any[] = [];
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    beta = {
      messages: {
        stream: (params: unknown) => {
          sent.push(params);
          return { on: () => undefined, finalMessage: async () => ({ stop_reason: 'end_turn' }) };
        },
      },
    };
  },
}));

const call = (model: string) =>
  claudeStream({ apiKey: 'k', model, system: 's', document: 'doc', prompt: 'q' });

describe('claudeStream caching', () => {
  it('caches the document for an hour on ask, where follow-ups come minutes apart', async () => {
    await call(CLAUDE_MODELS.deep);
    expect(sent.at(-1).messages[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('writes no cache for a one-shot outline, whose answer is saved instead', async () => {
    await call(CLAUDE_MODELS.quick);
    expect(sent.at(-1).messages[0].content[0].cache_control).toBeUndefined();
  });
});
