import { sendMessage } from '../../messages';
import { getLocal } from '../../storage';
import { resolveByText, type Connector } from './base';

export const memoryConnector: Connector = {
  id: 'memory',
  label: 'Assistant memory',
  isAvailable: () => true,
  tools: [
    {
      name: 'remember',
      description:
        "Remember a lasting fact or preference about the user (\"remember that my advisor is Dr. Lee\", \"remember I lift Mon/Wed/Fri\"). Not for to-dos — use add_task for things to do.",
      params: {
        type: 'object',
        required: ['fact'],
        additionalProperties: false,
        properties: {
          fact: { type: 'string', description: 'The fact to remember, one short sentence', maxLength: 280 },
        },
      },
      confirm: true,
      summary: (p) => `Remember “${p.fact as string}”`,
      run: async (p) => {
        const res = await sendMessage({ type: 'MEMORY_ADD', text: p.fact as string });
        if (!res.ok || !res.fact) throw new Error(res.error ?? 'Could not save that.');
        return `Remembered: “${res.fact.text}”.`;
      },
    },
    {
      name: 'forget',
      description:
        'Forget a fact previously remembered about the user. Takes the fact wording, not an id.',
      params: {
        type: 'object',
        required: ['fact'],
        additionalProperties: false,
        properties: {
          fact: { type: 'string', description: 'Words identifying the fact to forget', maxLength: 280 },
        },
      },
      confirm: true,
      summary: (p) => `Forget “${p.fact as string}”`,
      run: async (p) => {
        const { assistantMemory } = await getLocal('assistantMemory');
        const res = resolveByText(assistantMemory, (f) => f.text, p.fact as string);
        if (res.kind === 'none') {
          throw new Error(`I don't have a remembered fact matching “${p.fact as string}”.`);
        }
        if (res.kind === 'ambiguous') {
          const names = res.candidates.map((f) => `“${f.text}”`).join(', ');
          throw new Error(`A few facts match — did you mean ${names}? Say it more specifically.`);
        }
        await sendMessage({ type: 'MEMORY_DELETE', id: res.item.id });
        return `Forgotten: “${res.item.text}”.`;
      },
    },
  ],
};
