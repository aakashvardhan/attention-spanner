import { describe, expect, it } from 'vitest';
import { statusText } from './SuggestedFeeds';

const done = (suggestions: number, checked: number, unreachable: number) => ({
  state: 'done' as const,
  result: {
    suggestions: Array.from({ length: suggestions }, (_, i) => ({ feedUrl: `https://s${i}.example/rss`, host: `s${i}.example`, visits: 3 })),
    checked,
    unreachable,
  },
});

describe('statusText', () => {
  it('says what was found, out of how many sites, and what could not be reached', () => {
    expect(statusText(done(2, 12, 0))).toBe('Found 2 feeds on the 12 sites you visit most.');
    expect(statusText(done(1, 12, 3))).toBe("Found 1 feed on the 12 sites you visit most. 3 couldn't be reached.");
  });

  it('tells apart no history, no feeds, and no connection', () => {
    expect(statusText(done(0, 0, 0))).toBe('Not enough browsing in the last 7 days to suggest anything yet.');
    expect(statusText(done(0, 12, 2))).toBe("None of the 12 sites you visit most publish a feed. 2 couldn't be reached.");
    expect(statusText(done(0, 5, 5))).toBe("Couldn't reach any of the 5 sites you visit most. Check your connection and try again.");
  });

  it('explains a declined permission without blame, and passes errors through', () => {
    expect(statusText({ state: 'denied' })).toBe(
      'Suggestions need access to your history. It is read on this computer only; nothing is stored or sent.',
    );
    expect(statusText({ state: 'error', message: "You're offline." })).toBe("You're offline.");
    expect(statusText({ state: 'scanning' })).toBe('Checking the sites you visit most...');
    expect(statusText({ state: 'idle' })).toBe('');
  });
});
