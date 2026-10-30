/**
 * The brain dump: get a loop out of your head, read it back a little lighter,
 * and let it lock away. Claude Haiku turns the dump into a few gentle
 * reframes; nothing here makes tasks, steps or priorities.
 */

export const MAX_DUMP_CHARS = 4000;
export const ASK_TIMEOUT_MS = 60_000;

export const FAILED_MESSAGE = "Couldn't reach Haiku. Your words are still here.";
export const NO_KEY_MESSAGE = 'Add a Claude key in Settings to get bullets. Your words are still here.';

const MAX_BULLETS = 6;

export const REFRAME_SYSTEM = `Someone wrote down what is looping in their head. Give it back to them a little lighter.

Reply with 2 to 6 bullets, one per line, each starting with "- ". Nothing else: no heading, no intro, no closing line.

Rules:
- Stay faithful to what they wrote. Add no new facts.
- Name feelings as feelings, not verdicts. Shrink a catastrophe to what is actually known.
- No advice, no tasks, no "you should", no next steps.
- No exclamation marks, no cheerleading, no emojis.
- Plain, warm, short sentences.

Example: "nowhere near in career" becomes "- Career feels slow right now. That's a feeling, not a verdict."`;

/** Bullet lines from Haiku's reply; a preamble or prose line is dropped */
export function parseReframe(reply: string): string[] {
  return reply
    .split('\n')
    .map((line) => line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)/)?.[1]?.trim())
    .filter((line): line is string => Boolean(line))
    .slice(0, MAX_BULLETS);
}
