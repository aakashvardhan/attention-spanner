import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Later tasks append { name, pattern } here; each cut feature must never come back.
// Patterns must not use the g or y flag: hits() reuses one RegExp across lines and .test() would carry lastIndex.
const CUT: { name: string; pattern: RegExp }[] = [
  { name: 'Hero', pattern: /\bHero\b|edition-masthead/ },
  { name: 'weather', pattern: /weatherLocation|WeatherCache|\bWeather\b/ },
  { name: 'greeting', pattern: /displayName/ },
  { name: 'ambient', pattern: /ambientMotion|useAmbient|ObstacleCourse/ },
  { name: 'quote', pattern: /quoteOfDay/ },
  { name: 'bookmarks', pattern: /BOOKMARK|Bookmark(Link|Group|sPanel)|useBookmarks|bookmark-link/ },
  { name: 'now-watching', pattern: /NowWatching|useNowWatching/ },
  { name: 'drift', pattern: /checkDrift|useDriftNudge|driftChecked|LAYA_DRIFT_MIN|focusDrift/ },
  { name: 'hyperfocus', pattern: /hyperfocus|HYPERFOCUS/i },
  { name: 'flowtunes', pattern: /focusMusic|flowtunes/i },
  { name: 'gemini', pattern: /geminiKey\b|geminiVideoStream|Gemini watched/ },
  { name: 'suggested-feeds', pattern: /SuggestedFeeds|rankDomains|suggestFeeds|isFollowed|isPublicHost|DiscoveryDeps|DiscoveryResult|SiteScore|HistoryVisit|MIN_VISITS/ },
  { name: 'ai-stats', pattern: /recordStat|updateStats|settleProbes|probePercent|aiStats|AiStats|ImpactRows/ },
  { name: 'nudges', pattern: /scheduleNudge|cancelNudge|fireNudge|nudgesEnabled|NUDGE_|nudgePrefix|lastGlobalNudgeAt/ },
  { name: 'lead-story', pattern: /edition-lead|edition-headline|edition-cta|leadStatus|kickerFor/ },
  { name: 'video-categories', pattern: /groupByCategory|videoCategory|edition-also/ },
  { name: 'breathing-guide', pattern: /pomo-breath|BREATH_MS|breatheAgain/ },
  { name: 'pace-forecast', pattern: /paceMinutesLeft|paceLabel|relay-row-forecast/ },
  { name: 'watching-card', pattern: /relay-watching-card/ },
  { name: 'sweep', pattern: /SAMPLE_FEEDS|sample-feed|ai-impact|FOCUS_VIDEO_TAB/ },
];

// These name dead keys on purpose (sweep lists and fixtures).
const SKIP = new Set([
  'src/shared/storage.ts',
  'src/shared/storage.test.ts',
  'src/background/alarms.test.ts',
  'src/shared/cutFeatures.test.ts',
]);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out']);

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(p, acc);
    } else if (/\.(tsx?|css)$/.test(e.name) && !SKIP.has(p)) acc.push(p);
  }
  return acc;
}

const files = ['src', 'e2e', 'mcp'].flatMap((d) => {
  try {
    return walk(d);
  } catch {
    return [];
  }
});

function hits(pattern: RegExp): string[] {
  const out: string[] = [];
  for (const f of files)
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((l, i) => {
        if (pattern.test(l)) out.push(`${f}:${i + 1}`);
      });
  return out;
}

describe('cut features stay cut', () => {
  it('scans real files', () => expect(files.length).toBeGreaterThan(50));
  it.skipIf(CUT.length === 0)('has entries once the cuts start', () => {
    expect(CUT.length).toBeGreaterThan(0);
  });
  for (const { name, pattern } of CUT) it(`${name} stays cut`, () => expect(hits(pattern)).toEqual([]));
});
