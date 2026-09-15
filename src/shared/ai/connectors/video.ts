import { sendMessage } from '../../messages';
import type { Connector } from './base';

/**
 * The video playing right now, as tools rather than only a panel row.
 *
 * Same argument as liveConnector: making these tools is what puts them in the
 * command palette for free, and "what did they say about X" is a question you
 * ask while watching, not something you go looking for a button to do.
 *
 * All three are reads, so none carry `confirm` — staging them behind an
 * approval chip would break the one interaction they exist for. `now_watching`
 * is 'auto' because it is a single storage read; the other two are 'costly'
 * because they reach for a transcript and, for catch-up, a model.
 */
export const videoConnector: Connector = {
  id: 'video',
  label: 'YouTube',
  isAvailable: () => true,
  tools: [
    {
      name: 'now_watching',
      loop: 'auto',
      description:
        'What YouTube video the user is watching right now, with how far into it they are ' +
        'and the current chapter. Use for "what am I watching", "how far in am I", ' +
        '"how much is left". Returns nothing when no video is playing.',
      params: { type: 'object', required: [], additionalProperties: false, properties: {} },
      palette: {
        label: 'What am I watching?',
        keywords: ['watching', 'video', 'youtube', 'playing', 'now'],
      },
      summary: () => 'Check what is playing',
      run: async () => (await sendMessage({ type: 'VIDEO_NOW_WATCHING' })).text,
    },
    {
      name: 'video_catch_up',
      loop: 'costly',
      description:
        'Summarize what was just said in the YouTube video playing right now — for when the ' +
        'user drifted off and needs the thread back ("what did I just watch", "recap this", ' +
        '"I zoned out"). Only covers speech up to the current playhead, never ahead of it.',
      params: {
        type: 'object',
        required: [],
        additionalProperties: false,
        properties: {
          minutes: {
            type: 'number',
            description: 'How far back to summarize, in minutes. Defaults to 10.',
          },
        },
      },
      palette: {
        label: 'Summarize what I just watched',
        keywords: ['summarize', 'watched', 'recap', 'video', 'missed', 'zoned'],
      },
      summary: () => 'Summarize what you just watched',
      run: async (p) => {
        const minutes = typeof p.minutes === 'number' ? p.minutes : 10;
        const res = await sendMessage({ type: 'VIDEO_CATCH_UP', minutes });
        return res.text;
      },
    },
    {
      name: 'search_video_transcript',
      loop: 'costly',
      description:
        'Find where something was said in the YouTube video playing right now. Use for ' +
        '"what did they say about X", "did they mention Y", "find the part about Z". ' +
        'Returns matching lines with their timestamps.',
      params: {
        type: 'object',
        required: ['query'],
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'The word or phrase to find in the transcript.' },
        },
      },
      palette: {
        label: 'Find in this video…',
        keywords: ['find', 'said', 'transcript', 'video', 'quote', 'mention'],
      },
      summary: (p) => `Search this video for “${String(p.query ?? '')}”`,
      run: async (p) => {
        const res = await sendMessage({
          type: 'VIDEO_TRANSCRIPT_SEARCH',
          query: String(p.query ?? ''),
        });
        return res.text;
      },
    },
  ],
};
