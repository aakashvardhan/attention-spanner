import type { AssistantProvider, AssistantTurn, GenerateRequest, ProviderReply } from './assistantTypes';
import { createSession, getAvailability } from './brainDump';

/**
 * AssistantProvider over on-device Gemini Nano (Prompt API). Same rules as
 * brainDump.ts: extension pages only, never the MV3 service worker. Tool
 * routing happens via schema-constrained JSON in the orchestrator, so
 * GenerateRequest.tools is ignored here.
 */

const NANO_TIMEOUT_MS = 45_000;

function toHistory(turns: AssistantTurn[]): LanguageModelMessage[] {
  return turns.map((t) => ({ role: t.role, content: t.text }));
}

export const nanoProvider: AssistantProvider = {
  id: 'nano',

  async available() {
    const availability = await getAvailability();
    // 'downloadable' counts: the first create() kicks off the one-time download
    return availability === 'available' || availability === 'downloadable';
  },

  async generate(req: GenerateRequest): Promise<ProviderReply> {
    const last = req.turns[req.turns.length - 1];
    if (!last || last.role !== 'user') {
      throw new Error('generate() needs a trailing user turn');
    }

    const session = await createSession(req.system, undefined, toHistory(req.turns.slice(0, -1)));
    const signal = req.signal
      ? AbortSignal.any([req.signal, AbortSignal.timeout(NANO_TIMEOUT_MS)])
      : AbortSignal.timeout(NANO_TIMEOUT_MS);

    try {
      if (req.responseSchema) {
        const text = await session.prompt(last.text, {
          responseConstraint: req.responseSchema as Record<string, unknown>,
          signal,
        });
        return { text };
      }
      if (req.onToken) {
        const reader = session.promptStreaming(last.text, { signal }).getReader();
        let text = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += value;
          req.onToken(text);
        }
        return { text };
      }
      return { text: await session.prompt(last.text, { signal }) };
    } finally {
      session.destroy();
    }
  },
};
