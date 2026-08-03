import { sendMessage } from '../../messages';
import type { Connector } from './base';

/**
 * Live mode as a tool rather than only a button. Making it a tool is what gets
 * it into the command palette and the wake word for free — "hey Jarvis, what
 * did I miss" is the way you'd actually reach for this, and a button in a panel
 * you aren't looking at is no use when you have just resurfaced.
 */
export const liveConnector: Connector = {
  id: 'live',
  label: 'Live meeting',
  isAvailable: () => true,
  tools: [
    {
      name: 'catch_me_up',
      loop: 'costly',
      description:
        'Summarize what was just said in the meeting or lecture being recorded right now — ' +
        'for when the user lost the thread and needs to rejoin ("what did I miss", ' +
        '"catch me up", "I zoned out"). Only works while a recording is in progress.',
      params: {
        type: 'object',
        required: [],
        additionalProperties: false,
        properties: {
          minutes: {
            type: 'number',
            description: 'How far back to summarize, in minutes. Defaults to 5.',
          },
        },
      },
      palette: {
        label: 'Catch me up',
        keywords: ['missed', 'miss', 'catch', 'zoned', 'recap', 'meeting'],
      },
      summary: () => 'Summarize what you missed',
      run: async (p) => {
        const raw = typeof p.minutes === 'number' ? p.minutes : 5;
        // The model will happily ask for 90 minutes; the window is what we pay for.
        const minutes = Math.max(1, Math.min(15, Math.round(raw)));
        const res = await sendMessage({ type: 'LIVE_CATCH_UP', minutes });
        return res.text;
      },
    },
  ],
};
