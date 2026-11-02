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
  // v27: papers library
  { name: 'rss', pattern: /refreshFeeds|rssParser|FeedItem|VALIDATE_FEED|MARK_ALL_READ|feedDiscovery|TriageCard/ },
  { name: 'video', pattern: /videoTracker|VIDEO_PROGRESS|VIDEO_TRACKER|youtubeCaptions|timedtextTee|watchMeta/ },
  { name: 'topic-gate', pattern: /topicGate|geminiTopic|mutedTopics|trackTopics|topicVerdicts/ },
  { name: 'web-tracking', pattern: /readingTracker|readingProgress|ContinueRow|TRACKER_READY|PROGRESS_UPDATE/ },
  { name: 'local-ai', pattern: /ollama|Ollama|\blaya|Laya|cloudMode|aiVectors|RecallSearch|RecapCard/ },
  { name: 'passes', pattern: /ReadingPass|passGate|PassLock|useProvocations|ProvocationCard|CounterpointCard|PROV_ADD/ },
  { name: 'pomodoro', pattern: /breakMinutes|focusSound|nextPhase|FocusTimer|FocusDial|HoldToQuit|CHIME_PAGE|START_FOCUS/ },
  { name: 'article-reader', pattern: /ArticleReader|ArticleViewport|articleExtract|articleReaderPath/ },
  { name: 'citations', pattern: /bibliography|citeFormats|CitationTooltip|cite-marker|TrackPrompt/ },
  { name: 'semantic-scholar', pattern: /semanticScholar|SEMANTIC_SCHOLAR|fetchPaperMeta/ },
  { name: 'decks', pattern: /FLASH_ADD_DECK|deckId|DeckList|PaperDeck/ },
  // v28: one walnut theme
  { name: 'themes', pattern: /paperwhite|readerNight|data-theme|data-phase|useTheme|initTheme|ThemeSetting/ },
];

// These name dead keys on purpose (sweep lists and fixtures).
const SKIP = new Set([
  'src/shared/storage.ts',
  'src/shared/storage.test.ts',
  'src/background/alarms.test.ts',
  'src/shared/cutFeatures.test.ts',
  // Seeds a legacy profile for the Rust migration, so it names dead keys.
  'e2e/port-migration.e2e.ts',
  // Asserts the retired theme blocks are absent, so it names them.
  'src/shared/theme.test.ts',
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
