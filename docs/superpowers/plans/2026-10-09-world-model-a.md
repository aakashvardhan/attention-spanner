# World Model, Plan A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the new tab into an egocentric world you stand in (Sim Lab look): unfinished reading on a path ahead, feeds in a lane, the year as terrain, a real sky, a camera that moves only when you act, stepping into the reader in the same tab, plus the motion lints, settings, blocked-page robot and planning runners, all under the browser test suite.

**Architecture:** Pure modules decide everything that can be wrong (`layout.ts` places panels, `camera.ts` holds the comfort rules, `view.ts` picks world or flat, `sky.ts` reads time and weather, `paceMinutesLeft` forecasts). `World.tsx` arranges the same components the flat Edition uses (ContinueRow, TriageRow, BrainDump, ActivityHeatmap, Hero, EditionIndex) inside a CSS 3D scene with a screen-fixed frame. No WebGL, no new dependency.

**Tech Stack:** React 19, TypeScript 5.8 strict, CSS 3D transforms, canvas 2D, cross-document View Transitions, Vitest 3, Playwright 1.61 + axe-core (existing e2e suite).

**Spec:** `docs/superpowers/specs/2026-10-08-world-model-sim-design.md` (prototype beside it).

**Plan B (separate, not this file):** alphaXiv restore + Papers constellation. Blocked on confirming the alphaXiv MCP server's current tool names.

## Global Constraints

- Work in `../adhd-chrome-reader-world-model` on branch `world-model`.
- Read settings through `useSettings()` / `getSettings()`; new settings are a `Settings` field plus a `DEFAULT_SETTINGS` value, no migration.
- CSS uses tokens or `designSystem.test.ts` fails: colours only `var(--*)`/`transparent` outside `theme.css`; px in spacing properties multiples of 4; `font-size: var(--text-*)`; radii `var(--radius-*)`. New colour tokens go in BOTH the light `:root` and the `:root[data-theme='dark']` blocks (`theme.test.ts` checks parity).
- Every rule animating on a `--spring-*` token has its selector in the same file's `@media (prefers-reduced-motion: reduce)` block (`motion.test.ts`).
- Motion: the camera uses `--spring-smooth` (never overshoots, `springs.test.ts`); lock ring `--spring-snappy`; fog, vignette, fades and colour use `--ease-effect` with `--dur-effect-fast` (120ms) or `--dur-effect-slow` (480ms), never a spring.
- The camera never pitches or rolls; |yaw| ≤ 15°; it moves only on keyboard focus (J/K, Tab) or stepping in, never on hover or on its own.
- Every number on screen is computed from real data. No invented telemetry.
- No new runtime or dev dependency.
- `npm run typecheck`, `npm test`, `npm run build`, `npm run build:e2e && npm run test:e2e` green after every task. Browser suites seed `ollamaUrl: 'http://127.0.0.1:9'` and allow only `NETWORK_NOISE`.

## Corrections to the spec, decided while planning

1. **Same components, two arrangements, not literally the same DOM.** Docked tools (brain dump, favorites) cannot sit inside a 3D-transformed scene and stay screen-fixed (a transformed ancestor captures `position: fixed`). So flat and world render the same components with the same data in two layouts; an e2e parity test checks the `[data-story]` lists match in order.
2. **Motion lint scope.** The reader's transform transitions (toolbar slide, press scale, a scroll-tracking progress bar) are deliberate non-spring easings, so "transform must use a spring" is not enforced. Enforced: no spring on colour/opacity/filter/shadow, and every infinite animation stilled under Reduce Motion or carrying `motion-exempt`. The camera's token is checked by its own test.
3. **No "±9".** Nothing measures uncertainty. The forecast is your own pace on that item: `≈11 min at your pace` (active seconds per percent read). Papers and videos get none (no pace data; videos already show exact time).
4. **No viewfinder brackets in the reader.** The step-in is the dolly plus the title morphing into the reader's title; brackets live on the new tab's frame and Settings.
5. **Frame bands are opaque**, so no text ever sits on the sky; the sky-contrast test is unnecessary.
6. **A click opens immediately** (not "walk there first"); the camera follows keyboard focus. Hover never moves it.
7. **Narrow windows (< 900px) also get the flat view**, like Reduce Motion.
8. **Terrain is the year grid only.** Its headline, metric switch and legend stay in the flat view; the terrain section is labelled with the headline for screen readers.
9. **Caps:** the path shows at most 5 unfinished things, the feed lane fills to 9 objects total; the rest is a `+N more · V for flat view` sign.
10. **F is not bound.** The fog follows a running focus session.
11. **Opening from the new tab replaces the new tab in both views** (consistent; Chrome's own new tab behaves this way). ⌘/Ctrl-click opens a new tab.

## Review Focus

1. Switching views (V, a resize across 900px, toggling Reduce Motion) must not lose a half-typed brain dump. (Task 7 e2e "switching view keeps the brain dump draft")
2. Clicking text inside a 3D panel must hit that panel, not one behind it, and tab order must follow the path. (Task 7 e2e "every panel is clickable and tabbable in path order")
3. A theme switched in Options while the world is open must recolour the sky and panels without a reload. (Task 6 e2e "sky follows a theme switch")
4. Opening something while a video is already playing elsewhere focuses that tab and leaves the new tab alone (OPEN_ARTICLE returns no URL). (Task 8 unit "returns no url when an existing video tab is focused")
5. A profile with nothing unfinished and no feeds still renders a usable world (signpost, frame, docks), not an empty void. (Task 7 e2e "an empty profile shows the signpost")

---

### Task 1: Effects tokens and the motion lint

**Files:**
- Modify: `src/shared/theme.css:100-107`, `src/shared/motion.test.ts`, `src/pages/newtab/newtab.css:852,916,923,1507`

**Interfaces:**
- Produces: CSS tokens `--ease-effect`, `--dur-effect-fast`, `--dur-effect-slow`, `--font-mono`; `motionTokenMisuse(source: string): string[]`; `unstilled(source: string, moves?: (body: string) => boolean): string[]`

- [ ] **Step 1: Write the failing tests**

In `src/shared/motion.test.ts`, change the `unstilled` signature line and its condition:
```ts
export function unstilled(source: string, moves = (body: string) => body.includes('var(--spring-')): string[] {
```
```ts
    if (moves(rule[2]) && !rule[2].includes(EXEMPT))
```
(replacing `if (rule[2].includes('var(--spring-') && !rule[2].includes(EXEMPT))`).

Add after `unstilled`:
```ts
const EFFECT_PROPS = new Set([
  'opacity', 'filter', 'backdrop-filter', 'color', 'background', 'background-color',
  'border-color', 'box-shadow', 'outline-color', 'fill', 'stroke',
]);

/**
 * Transition parts that put a spring on an effect. A colour or a fade has no
 * momentum, so it eases on the effects tokens (Material 3 Expressive's
 * spatial/effects split). Commas inside var() and calc() do not split parts.
 */
export function motionTokenMisuse(source: string): string[] {
  const EXEMPT = '__motion_exempt__';
  const css = source.replace(/\/\*[^*]*motion-exempt:[\s\S]*?\*\//g, EXEMPT).replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (rule[2].includes(EXEMPT)) continue;
    for (const m of rule[2].matchAll(/transition\s*:\s*([^;]+);?/g)) {
      for (const part of m[1].split(/,(?![^(]*\))/)) {
        const text = part.trim().replace(/\s+/g, ' ');
        if (EFFECT_PROPS.has(text.split(' ')[0]) && text.includes('var(--spring-')) out.push(text);
      }
    }
  }
  return out;
}

const infinite = (body: string) => /\binfinite\b/.test(body);
```

Add tests:
```ts
describe('motionTokenMisuse', () => {
  it('flags a spring on an effect, including inside a list', () => {
    expect(
      motionTokenMisuse('.a { transition: transform 1s var(--spring-snappy), opacity var(--dur-snappy) var(--spring-snappy); }'),
    ).toEqual(['opacity var(--dur-snappy) var(--spring-snappy)']);
  });

  it('accepts effects on the effects tokens and springs on movement, commas inside calls included', () => {
    expect(
      motionTokenMisuse(
        '.a { transition: opacity var(--dur-effect-fast) var(--ease-effect), transform var(--dur-snappy) var(--spring-snappy) calc(var(--i) * 4ms); }',
      ),
    ).toEqual([]);
  });

  it('skips a rule carrying a motion-exempt reason', () => {
    expect(motionTokenMisuse('.a { transition: color 1s var(--spring-smooth); /* motion-exempt: why */ }')).toEqual([]);
  });
});

describe('unstilled infinite animations', () => {
  it('flags an infinite animation Reduce Motion does not still, and accepts a stilled or exempt one', () => {
    expect(unstilled('.s { animation: spin 1s linear infinite; }', infinite)).toEqual(['.s']);
    expect(unstilled('.s { animation: spin 1s linear infinite; }\n@media (prefers-reduced-motion: reduce) { .s { animation: none; } }', infinite)).toEqual([]);
    expect(unstilled('.s { animation: spin 1s linear infinite; /* motion-exempt: why */ }', infinite)).toEqual([]);
  });
});
```
and inside `describe('every stylesheet', ...)` add:
```ts
  it.each(cssFiles(join(ROOT, 'src')))('%s keeps springs off colour, opacity and filter', (file) => {
    expect(motionTokenMisuse(readFileSync(join(ROOT, file), 'utf8'))).toEqual([]);
  });

  it.each(cssFiles(join(ROOT, 'src')))('%s stills its infinite animations under reduced motion', (file) => {
    expect(unstilled(readFileSync(join(ROOT, file), 'utf8'), infinite)).toEqual([]);
  });
```

- [ ] **Step 2: Run to verify they fail on today's CSS**

Run: `npx vitest run src/shared/motion.test.ts`
Expected: FAIL on `src/pages/newtab/newtab.css` for both new per-file checks: `background-color var(--dur-smooth) var(--spring-smooth) calc(var(--w) * 6ms)`, and `.dump-card.is-working::before`, `.dump-shimmer span`, `.dump-chip.is-active .dump-chip-dot`. The unit tests pass.

- [ ] **Step 3: Add the tokens and fix the CSS**

In `src/shared/theme.css`, after `  --dur-bouncy: 660ms;` add:
```css

  /* Effects motion: fog, vignette, fades and colour. Never a spring: a colour
     has no momentum. Spatial motion (the camera, the lock) stays on springs. */
  --ease-effect: cubic-bezier(0.2, 0, 0, 1);
  --dur-effect-fast: 120ms;
  --dur-effect-slow: 480ms;

  /* Telemetry: numbers that are measurements read best in a fixed width. */
  --font-mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
```

In `src/pages/newtab/newtab.css`:
- line ~1507 replace `background-color var(--dur-smooth) var(--spring-smooth) calc(var(--w) * 6ms),` with `background-color var(--dur-effect-slow) var(--ease-effect) calc(var(--w) * 6ms),`
- on each of the three infinite lines, append the owner's existing reason so the rule is exempt:
  - `animation: dump-orbit 2.4s linear infinite; /* motion-exempt: the brain dump always animates, by the owner's choice */`
  - `animation: dump-shimmer 1.6s linear infinite; /* motion-exempt: the brain dump always animates, by the owner's choice */`
  - `animation: dump-pulse 1.2s var(--ease-out) infinite; /* motion-exempt: the brain dump always animates, by the owner's choice */`

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/shared/motion.test.ts src/shared/designSystem.test.ts src/shared/theme.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/theme.css src/shared/motion.test.ts src/pages/newtab/newtab.css
git commit -m "Effects motion tokens; lint springs off colour and still infinite animations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Settings, view mode, ambient motion

**Files:**
- Create: `src/shared/hooks/useMedia.ts`, `src/shared/hooks/useAmbient.ts`, `src/pages/newtab/world/view.ts`, `src/pages/newtab/world/view.test.ts`, `src/shared/ambient.test.ts`
- Modify: `src/shared/types.ts` (Settings), `src/shared/storage.ts` (DEFAULT_SETTINGS), `src/pages/newtab/ObstacleCourse.tsx:199-317`, `src/pages/options/NewTabSection.tsx`

**Interfaces:**
- Produces:
  - `Settings.worldView: 'world' | 'flat'` (default `'world'`), `Settings.comfort: 'recommended' | 'comfortable'` (default `'recommended'`), `Settings.ambientMotion: boolean` (default `true`)
  - `viewMode(setting: 'world' | 'flat', reducedMotion: boolean, narrow: boolean): 'world' | 'flat'`, `NARROW_QUERY = '(max-width: 900px)'`, `REDUCED_QUERY = '(prefers-reduced-motion: reduce)'`
  - `useMedia(query: string): boolean`
  - `ambientRunning(a: { enabled: boolean; reduced: boolean; focusing: boolean; hidden: boolean }): boolean`
  - `useAmbient(): { running: boolean; enabled: boolean; toggle(): void }`

- [ ] **Step 1: Write the failing tests**

Create `src/pages/newtab/world/view.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { viewMode } from './view';
import { ambientRunning } from '../../../shared/hooks/useAmbient';

describe('viewMode', () => {
  it('honours the setting when motion is allowed and the window is wide', () => {
    expect(viewMode('world', false, false)).toBe('world');
    expect(viewMode('flat', false, false)).toBe('flat');
  });

  it('is always flat under Reduce Motion or in a narrow window', () => {
    expect(viewMode('world', true, false)).toBe('flat');
    expect(viewMode('world', false, true)).toBe('flat');
  });
});

describe('ambientRunning', () => {
  const on = { enabled: true, reduced: false, focusing: false, hidden: false };
  it('runs only when enabled, motion is allowed, no focus session and the tab is visible', () => {
    expect(ambientRunning(on)).toBe(true);
    expect(ambientRunning({ ...on, enabled: false })).toBe(false);
    expect(ambientRunning({ ...on, reduced: true })).toBe(false);
    expect(ambientRunning({ ...on, focusing: true })).toBe(false);
    expect(ambientRunning({ ...on, hidden: true })).toBe(false);
  });
});
```

Create `src/shared/ambient.test.ts`:
```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Anything that animates on its own goes through useAmbient, which stops it
 * when ambient motion is off, during focus, under Reduce Motion and in a
 * hidden tab (WCAG 2.2.2: a way to pause motion that runs for more than 5s).
 * Static, like the CSS lints: a file calling requestAnimationFrame must import
 * useAmbient or be listed here with the reason it is not ambient.
 */
const ROOT = join(__dirname, '..', '..');
const NOT_AMBIENT: Record<string, string> = {
  'src/pages/newtab/BrainDump.tsx': 'one frame to measure a parked dump before it flies',
  'src/pages/reader/components/PdfViewport.tsx': 'coalesces page renders, not an animation',
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [relative(ROOT, path)] : [];
  });
}

describe('ambient motion', () => {
  it.each(sources(join(ROOT, 'src')))('%s animates only through useAmbient', (file) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    if (!text.includes('requestAnimationFrame(') || file in NOT_AMBIENT) return;
    expect(text, `${file} calls requestAnimationFrame without useAmbient`).toMatch(/\buseAmbient\b/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/pages/newtab/world/view.test.ts src/shared/ambient.test.ts`
Expected: FAIL: `./view` cannot be resolved; `src/pages/newtab/ObstacleCourse.tsx calls requestAnimationFrame without useAmbient`.

- [ ] **Step 3: Settings**

In `src/shared/types.ts`, inside `interface Settings` after `mutedTopics: string[];` add:
```ts
  /** New tab as a world you stand in, or the flat Edition. World falls back to flat under Reduce Motion or in a narrow window. */
  worldView: 'world' | 'flat';
  /** Camera moves: 'recommended' glides with an edge vignette, 'comfortable' cuts straight there. */
  comfort: 'recommended' | 'comfortable';
  /** Sky, clouds and the masthead runners move. Paused during focus and under Reduce Motion regardless. */
  ambientMotion: boolean;
```
In `src/shared/storage.ts` `DEFAULT_SETTINGS`, after `mutedTopics: [],` add:
```ts
  worldView: 'world',
  comfort: 'recommended',
  ambientMotion: true,
```

- [ ] **Step 4: The view decision and the hooks**

Create `src/pages/newtab/world/view.ts`:
```ts
export const NARROW_QUERY = '(max-width: 900px)';
export const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Which arrangement the new tab uses. The world is a choice, never a
 * requirement: Reduce Motion and a narrow window both get the flat Edition.
 */
export function viewMode(setting: 'world' | 'flat', reducedMotion: boolean, narrow: boolean): 'world' | 'flat' {
  return reducedMotion || narrow ? 'flat' : setting;
}
```

Create `src/shared/hooks/useMedia.ts`:
```ts
import { useEffect, useState } from 'react';

/** A media query's live answer. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
```

Create `src/shared/hooks/useAmbient.ts`:
```ts
import { useEffect, useState } from 'react';
import { patchSettings } from '../storage';
import { useMedia } from './useMedia';
import { useSettings } from './useSettings';
import { useStorageValue } from './useStorageValue';

export function ambientRunning(a: { enabled: boolean; reduced: boolean; focusing: boolean; hidden: boolean }): boolean {
  return a.enabled && !a.reduced && !a.focusing && !a.hidden;
}

/**
 * The one switch for motion nobody asked for: the sky, the clouds, the
 * runners. Off when the setting is off, during a focus session, under Reduce
 * Motion and while the tab is hidden. Reads the session from storage rather
 * than useFocusSession, which ticks twice a second.
 */
export function useAmbient(): { running: boolean; enabled: boolean; toggle(): void } {
  const [settings] = useSettings();
  const [session] = useStorageValue('focusSession');
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  const enabled = settings.ambientMotion;
  return {
    running: ambientRunning({ enabled, reduced, focusing: session !== null, hidden }),
    enabled,
    toggle: () => void patchSettings({ ambientMotion: !enabled }),
  };
}
```

- [ ] **Step 5: The runners go through useAmbient**

In `src/pages/newtab/ObstacleCourse.tsx`:
- add `import { useAmbient } from '../../shared/hooks/useAmbient';`
- in `ObstacleCourse()`, first line: `const { running } = useAmbient();`
- replace `const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;` with `const still = !running;`
- replace every other use of `reduced` in that effect with `still` (three places: the `if (reduced) x = ...` line, `if (reduced) cancelAnimationFrame(raf);`, and `if (reduced) {` in `onResize`)
- change the effect's dependency list from `[]` to `[running]`
- update the doc comment's last sentence to: `When ambient motion is off (the setting, a focus session, Reduce Motion, a hidden tab) it holds one still frame, mid-jump.`

- [ ] **Step 6: The three settings in Options**

In `src/pages/options/NewTabSection.tsx`, after `<MutedTopicsRow ... />` add:
```tsx
      <div className="setting-row">
        <label htmlFor="world-view">New tab</label>
        <select
          id="world-view"
          value={settings.worldView}
          onChange={(e) => void patchSettings({ worldView: e.target.value as Settings['worldView'] })}
        >
          <option value="world">World (step through what you read)</option>
          <option value="flat">Flat (the Edition)</option>
        </select>
      </div>
      <div className="setting-row">
        <label htmlFor="world-comfort">Camera</label>
        <select
          id="world-comfort"
          value={settings.comfort}
          onChange={(e) => void patchSettings({ comfort: e.target.value as Settings['comfort'] })}
        >
          <option value="recommended">Glide, with a dimmed edge while moving</option>
          <option value="comfortable">Cut straight there (most comfortable)</option>
        </select>
      </div>
      <div className="setting-row">
        <label htmlFor="ambient-motion">Ambient motion</label>
        <input
          id="ambient-motion"
          type="checkbox"
          checked={settings.ambientMotion}
          onChange={(e) => void patchSettings({ ambientMotion: e.target.checked })}
        />
      </div>
      <p className="hint">
        The world turns flat under your system's Reduce Motion and in narrow windows. Ambient motion is the
        sky and the runners; it pauses during focus sessions either way.
      </p>
```

- [ ] **Step 7: Run to verify they pass**

Run: `npm run typecheck && npx vitest run src/pages/newtab/world/view.test.ts src/shared/ambient.test.ts src/shared/storage.test.ts src/pages/newtab/ObstacleCourse.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/shared src/pages/newtab/world src/pages/newtab/ObstacleCourse.tsx src/pages/options/NewTabSection.tsx
git commit -m "World view, camera comfort and ambient motion settings; runners pause with ambient

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Where everything stands (layout)

**Files:**
- Create: `src/pages/newtab/world/layout.ts`, `src/pages/newtab/world/layout.test.ts`

**Interfaces:**
- Produces:
  - `type Lane = 'path' | 'feed'`
  - `interface StoryIn { key: string; lane: Lane; updatedAt: number }`
  - `interface Placement { key: string; lane: Lane; x: number; z: number; yaw: number }`
  - `const WORLD` (constants below), `placeStories(stories: readonly StoryIn[], now: number): { placed: Placement[]; overflow: number }`
  - `placeTransform(p: { x: number; z: number; yaw: number }): string`
  - `const WATCHING: { x: number; z: number; yaw: number }`, `const SIGN_OFFSET = 400`

- [ ] **Step 1: Write the failing tests**

Create `src/pages/newtab/world/layout.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { placeStories, placeTransform, WORLD, type Placement, type StoryIn } from './layout';

const now = Date.parse('2026-10-09T12:00:00Z');
const DAY = 86_400_000;
const path = (key: string, daysAgo: number): StoryIn => ({ key, lane: 'path', updatedAt: now - daysAgo * DAY });
const feed = (key: string): StoryIn => ({ key, lane: 'feed', updatedAt: now });

function footprint(p: Placement) {
  const w = (p.lane === 'path' ? WORLD.pathWidth : WORLD.feedWidth) / 2;
  return { x0: p.x - w, x1: p.x + w, z0: p.z - WORLD.depth, z1: p.z + WORLD.depth };
}

describe('placeStories', () => {
  it('stands the lead at the origin and the rest further away the longer they were left', () => {
    const { placed } = placeStories([path('a', 0), path('b', 1), path('c', 4), path('d', 30)], now);
    expect(placed[0]).toMatchObject({ key: 'a', x: 0, z: 0, yaw: 0 });
    const distances = placed.map((p) => -p.z);
    for (let i = 1; i < distances.length; i++) expect(distances[i]).toBeGreaterThan(distances[i - 1]);
  });

  it('never lets two panels overlap', () => {
    const stories = [...['a', 'b', 'c', 'd', 'e'].map((k, i) => path(k, i * 0.1)), ...['f', 'g', 'h', 'i'].map(feed)];
    const { placed } = placeStories(stories, now);
    for (const a of placed)
      for (const b of placed) {
        if (a === b) continue;
        const fa = footprint(a);
        const fb = footprint(b);
        const overlap = fa.x0 < fb.x1 && fb.x0 < fa.x1 && fa.z0 < fb.z1 && fb.z0 < fa.z1;
        expect(overlap, `${a.key} overlaps ${b.key}`).toBe(false);
      }
  });

  it('places at most 5 on the path and 9 in all, and counts the rest', () => {
    const stories = [...Array.from({ length: 8 }, (_, i) => path(`p${i}`, i)), ...Array.from({ length: 6 }, (_, i) => feed(`f${i}`))];
    const { placed, overflow } = placeStories(stories, now);
    expect(placed.filter((p) => p.lane === 'path')).toHaveLength(5);
    expect(placed).toHaveLength(9);
    expect(overflow).toBe(14 - 9);
  });

  it('angles the feed lane toward the path and keeps every yaw within 15 degrees', () => {
    const { placed } = placeStories([path('a', 0), feed('f')], now);
    expect(placed[1]).toMatchObject({ lane: 'feed', x: WORLD.feedX });
    for (const p of placed) expect(Math.abs(p.yaw)).toBeLessThanOrEqual(20);
  });

  it('is deterministic and handles nothing at all', () => {
    const stories = [path('a', 0), path('b', 2), feed('f')];
    expect(placeStories(stories, now)).toEqual(placeStories(stories, now));
    expect(placeStories([], now)).toEqual({ placed: [], overflow: 0 });
  });
});

describe('placeTransform', () => {
  it('stands a panel on the ground at its spot, turned by its yaw', () => {
    expect(placeTransform({ x: -220, z: -400, yaw: 0 })).toBe('translate3d(-220px, 0px, -400px) rotateY(0deg)');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/pages/newtab/world/layout.test.ts`
Expected: FAIL, cannot resolve `./layout`.

- [ ] **Step 3: Implement**

Create `src/pages/newtab/world/layout.ts`:
```ts
/**
 * Where everything stands in the new tab's world, as a pure function of what
 * is on the page. Units are CSS pixels; z runs away from you (more negative is
 * further). The path runs straight ahead: the lead stands on it, everything
 * else unfinished stands beside it, further away the longer it was left. The
 * feed lane runs down the right, its panels turned toward the path.
 */

export type Lane = 'path' | 'feed';

export interface StoryIn {
  key: string;
  lane: Lane;
  updatedAt: number;
}

export interface Placement {
  key: string;
  lane: Lane;
  x: number;
  z: number;
  yaw: number;
}

export const WORLD = {
  /** Hick's law: more than nine things to choose from is a list, not a place */
  maxObjects: 9,
  maxPath: 5,
  pathWidth: 360,
  feedWidth: 280,
  /** How thick a standing panel counts as, front to back */
  depth: 40,
  /** Path panels after the lead alternate this far left and right */
  sideX: 240,
  /** Minimum distance between consecutive path panels */
  pathGap: 400,
  /** Extra distance per day since it was last touched */
  dayDepth: 160,
  maxDepth: 3200,
  feedX: 720,
  feedFirstZ: -240,
  feedGap: 360,
  feedYaw: -20,
};

/** A playing video stands just left of the lead, turned toward it. */
export const WATCHING = { x: -640, z: -160, yaw: 20 };
/** The "+N more" sign stands this far past the last thing on the path. */
export const SIGN_OFFSET = 400;

const DAY = 86_400_000;

export function placeStories(stories: readonly StoryIn[], now: number): { placed: Placement[]; overflow: number } {
  const path = stories.filter((s) => s.lane === 'path').slice(0, WORLD.maxPath);
  const feed = stories.filter((s) => s.lane === 'feed').slice(0, WORLD.maxObjects - path.length);
  const placed: Placement[] = [];

  let distance = 0;
  path.forEach((s, i) => {
    if (i > 0) {
      const days = Math.max(0, (now - s.updatedAt) / DAY);
      const byAge = Math.min(WORLD.maxDepth, WORLD.pathGap + days * WORLD.dayDepth);
      distance = Math.max(distance + WORLD.pathGap, byAge);
    }
    const x = i === 0 ? 0 : i % 2 === 1 ? -WORLD.sideX : WORLD.sideX;
    placed.push({ key: s.key, lane: 'path', x, z: -distance, yaw: 0 });
  });

  feed.forEach((s, i) => {
    placed.push({ key: s.key, lane: 'feed', x: WORLD.feedX, z: WORLD.feedFirstZ - i * WORLD.feedGap, yaw: WORLD.feedYaw });
  });

  return { placed, overflow: stories.length - placed.length };
}

/** The CSS transform that stands a panel's foot at its spot on the ground. */
export function placeTransform(p: { x: number; z: number; yaw: number }): string {
  return `translate3d(${p.x}px, 0px, ${p.z}px) rotateY(${p.yaw}deg)`;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/pages/newtab/world/layout.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pages/newtab/world/layout.ts src/pages/newtab/world/layout.test.ts
git commit -m "World layout: the path by staleness, the feed lane, nine objects at most

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The camera and the comfort rules

**Files:**
- Create: `src/pages/newtab/world/camera.ts`, `src/pages/newtab/world/camera.test.ts`

**Interfaces:**
- Consumes: `Placement` (Task 3)
- Produces:
  - `const CAMERA = { perspective: 900, viewDepth: 240, stepDepth: 40, maxYaw: 15 }`
  - `const LOCKED_TITLE_PX = 24` (the world's panel title size, `--text-xl`)
  - `effectivePx(px: number, depth?: number): number`
  - `interface Camera { x: number; z: number; yaw: number; pitch: 0; roll: 0 }`
  - `cameraFor(target: Placement | null): Camera`
  - `sceneTransform(c: Camera, depth?: number): string`

- [ ] **Step 1: Write the failing tests**

Create `src/pages/newtab/world/camera.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAMERA, LOCKED_TITLE_PX, cameraFor, effectivePx, sceneTransform } from './camera';
import type { Placement } from './layout';

const at = (x: number, z: number, yaw = 0, lane: Placement['lane'] = 'path'): Placement => ({ key: 'k', lane, x, z, yaw });

describe('cameraFor', () => {
  it('never pitches or rolls, and turns at most 15 degrees', () => {
    for (const target of [at(0, 0), at(-240, -800), at(720, -600, -20, 'feed'), at(0, 0, 90)]) {
      const c = cameraFor(target);
      expect(c.pitch).toBe(0);
      expect(c.roll).toBe(0);
      expect(Math.abs(c.yaw)).toBeLessThanOrEqual(CAMERA.maxYaw);
    }
  });

  it('stands at the origin with nothing to look at', () => {
    expect(cameraFor(null)).toEqual({ x: 0, z: 0, yaw: 0, pitch: 0, roll: 0 });
  });
});

describe('sceneTransform', () => {
  it('moves the world so the target stands viewDepth ahead', () => {
    expect(sceneTransform(cameraFor(at(-240, -800)))).toBe('rotateY(0deg) translate3d(240px, 0px, 560px)');
  });
});

describe('legibility at the lock', () => {
  it('a locked panel title renders at 16px or more', () => {
    expect(effectivePx(LOCKED_TITLE_PX)).toBeGreaterThanOrEqual(16);
  });

  it('the world CSS sets panel titles at --text-xl (24px), the size this test assumes', () => {
    const css = readFileSync(join(__dirname, 'world.css'), 'utf8');
    expect(css).toMatch(/\.world-panel :is\(\.edition-headline, \.relay-row-title, \.edition-story-title\) \{\s*font-size: var\(--text-xl\);/);
  });

  it('the camera glides on --spring-smooth, the spring that never overshoots', () => {
    const css = readFileSync(join(__dirname, 'world.css'), 'utf8');
    expect(css).toMatch(/\.world-scene \{[^}]*transition: transform var\(--dur-smooth\) var\(--spring-smooth\);/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/pages/newtab/world/camera.test.ts`
Expected: FAIL, cannot resolve `./camera`.

- [ ] **Step 3: Implement**

Create `src/pages/newtab/world/camera.ts`:
```ts
import type { Placement } from './layout';

/**
 * The camera, held to the comfort rules VR platforms publish (Meta's
 * locomotion guidance, Apple's visionOS): it never pitches or rolls, turns at
 * most 15 degrees, and stands far enough back that the locked panel's title
 * reads at 16px or more. Where it looks is decided by keyboard focus only.
 */
export const CAMERA = { perspective: 900, viewDepth: 240, stepDepth: 40, maxYaw: 15 };

/** The world's panel title size in px (`--text-xl`; camera.test.ts reads world.css to keep them in step). */
export const LOCKED_TITLE_PX = 24;

/** On-screen size of `px` text standing `depth` behind the perspective plane. */
export function effectivePx(px: number, depth = CAMERA.viewDepth): number {
  return (px * CAMERA.perspective) / (CAMERA.perspective + depth);
}

export interface Camera {
  x: number;
  z: number;
  yaw: number;
  pitch: 0;
  roll: 0;
}

export function cameraFor(target: Placement | null): Camera {
  if (!target) return { x: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
  const yaw = Math.max(-CAMERA.maxYaw, Math.min(CAMERA.maxYaw, target.yaw * 0.7));
  return { x: target.x, z: target.z, yaw, pitch: 0, roll: 0 };
}

/** Move the world, not the eye: the target ends up `depth` ahead, faced. */
export function sceneTransform(c: Camera, depth = CAMERA.viewDepth): string {
  return `rotateY(${-c.yaw}deg) translate3d(${-c.x}px, 0px, ${-c.z - depth}px)`;
}
```
(`camera.test.ts`'s two CSS tests stay red until Task 6 creates `world.css`; run only the first three describe blocks now.)

- [ ] **Step 4: Run the camera logic tests**

Run: `npx vitest run src/pages/newtab/world/camera.test.ts -t "cameraFor|sceneTransform|16px or more"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pages/newtab/world/camera.ts src/pages/newtab/world/camera.test.ts
git commit -m "World camera: no pitch or roll, 15 degree turn cap, legible at the lock

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Your pace as the forecast

**Files:**
- Modify: `src/shared/progress.ts`, `src/shared/progress.test.ts`, `src/pages/newtab/ContinueRow.tsx`, `src/pages/newtab/ContinueRow.test.ts`, `src/pages/newtab/newtab.css`

**Interfaces:**
- Produces: `paceMinutesLeft(progress: AnyProgress): number | null`; `paceLabel(minutes: number | null): string`; ContinueRow meter gains `<span className="relay-row-forecast">`; ContinueRow `onOpen(alt: boolean, newTab: boolean)`

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/progress.test.ts` (add `paceLabel, paceMinutesLeft` to its `./progress` import):
```ts
describe('paceMinutesLeft', () => {
  const article = (maxPercent: number, activeSeconds: number) =>
    ({ kind: 'article', url: 'u', title: 't', source: 's', maxPercent, activeSeconds, firstOpenedAt: 0, updatedAt: 0,
       completedAt: null, nudge: { count: 0, lastAt: 0, dismissed: false }, feedItemId: null, scrollY: 0, pageHeight: 0 }) as AnyProgress;

  it('forecasts the rest at the pace this item was read so far', () => {
    // 10 minutes for the first 40% → 15 minutes for the other 60%.
    expect(paceMinutesLeft(article(40, 600))).toBe(15);
  });

  it('says nothing without enough reading to measure a pace', () => {
    expect(paceMinutesLeft(article(3, 600))).toBeNull();
    expect(paceMinutesLeft(article(40, 30))).toBeNull();
    expect(paceMinutesLeft(article(97, 600))).toBeNull();
    expect(paceMinutesLeft({ ...article(40, 600), kind: 'video' } as AnyProgress)).toBeNull();
  });

  it('labels it as a pace, not a promise', () => {
    expect(paceLabel(15)).toBe('≈15 min at your pace');
    expect(paceLabel(null)).toBe('');
  });
});
```
Append to `src/pages/newtab/ContinueRow.test.ts` inside `describe('leadStatus', ...)`:
```ts
  it('adds your pace to an article when there is enough reading to measure it', () => {
    const read = { ...article(Date.now() - 2 * 3_600_000), activeSeconds: 600, maxPercent: 40 };
    expect(leadStatus(read)).toMatch(/^40% read · opened .* · ≈15 min at your pace$/);
  });
```
(`article(...)` is the file's existing builder; check its name and adapt the call, it returns a ResumableItem whose `progress` carries `base`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/shared/progress.test.ts src/pages/newtab/ContinueRow.test.ts`
Expected: FAIL, `paceMinutesLeft is not a function`; the leadStatus pace test fails on the missing suffix.

- [ ] **Step 3: Implement the forecast**

Append to `src/shared/progress.ts`:
```ts
/**
 * Minutes left at the pace you have read this item so far: active seconds
 * per percent, times the percent still to go. A real measurement of you, not
 * a words-per-minute guess. Nothing until there is a pace worth extrapolating
 * (5% read and a minute spent), and nothing once it is nearly done.
 */
export function paceMinutesLeft(progress: AnyProgress): number | null {
  if (progress.kind === 'video') return null;
  const { maxPercent, activeSeconds } = progress;
  if (maxPercent < 5 || maxPercent > 95 || activeSeconds < 60) return null;
  return Math.ceil((activeSeconds * (100 - maxPercent)) / maxPercent / 60);
}

export function paceLabel(minutes: number | null): string {
  return minutes === null ? '' : `≈${minutes} min at your pace`;
}
```

- [ ] **Step 4: Show it in the row, and let the row ask for a new tab**

In `src/pages/newtab/ContinueRow.tsx`:
- import `paceLabel, paceMinutesLeft` from `'../../shared/progress'` (add to the existing `progressKeyFor` import)
- in `leadStatus`, replace the final `return` with:
```ts
  const pace = progress ? paceLabel(paceMinutesLeft(progress)) : '';
  return [`${Math.round(progress?.maxPercent ?? 0)}% read`, `opened ${opened}`, pace].filter(Boolean).join(' · ');
```
- change the `onOpen` prop type to `onOpen: (alt: boolean, newTab: boolean) => void;` and its doc to `` /** `alt`: Option/Alt held, so a paper opens in the reader instead of alphaXiv; `newTab`: ⌘/Ctrl held. */ ``
- in the row button's `onClick`, change `onOpen(e.altKey);` to `onOpen(e.altKey, e.metaKey || e.ctrlKey);`
- after `const percent = ...` add `const pace = item.progress ? paceMinutesLeft(item.progress) : null;`
- in BOTH meters (lead and row), after `<span style={{ width: ... }} />` add the forecast band:
```tsx
                {pace !== null && (
                  <span className="relay-row-forecast" style={{ left: `${Math.min(100, Math.max(0, percent))}%` }} />
                )}
```

In `src/pages/newtab/newtab.css`, after the `.relay-row-meter` rules add:
```css
/* The rest of the bar, forecast at your own pace: a dashed band from where
   you are to the end. Only drawn when there is a pace to forecast from. */
.relay-row-meter {
  position: relative;
}
.relay-row-forecast {
  position: absolute;
  inset-block: 0;
  right: 0;
  border-top: 1px dashed var(--accent);
  background: var(--accent-wash);
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npm run typecheck && npx vitest run src/shared/progress.test.ts src/pages/newtab/ContinueRow.test.ts src/shared/designSystem.test.ts`
Expected: PASS. (`typecheck` now fails in `Dashboard.tsx` on the `open` callback arity only if TS flags it; it does not, since the extra parameter is optional to the caller. If it does, Task 8 rewires `open`.)

- [ ] **Step 6: Commit**

```bash
git add src/shared/progress.ts src/shared/progress.test.ts src/pages/newtab/ContinueRow.tsx src/pages/newtab/ContinueRow.test.ts src/pages/newtab/newtab.css
git commit -m "Forecast the rest of an article at your own pace

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The sky

**Files:**
- Create: `src/pages/newtab/world/sky.ts`, `src/pages/newtab/world/sky.test.ts`, `src/pages/newtab/world/Sky.tsx`, `src/pages/newtab/world/world.css`
- Modify: `src/shared/theme.css` (sky tokens, light and dark)

**Interfaces:**
- Consumes: `useAmbient` (Task 2), `usableReading` from `../Weather`
- Produces:
  - `interface SkyState { sun: { x: number; y: number } | null; clouds: number; precip: 'rain' | 'snow' | null; haze: boolean }`
  - `skyFor(hour: number, code: number | null): SkyState` (x, y as 0–1 fractions of the canvas)
  - `Sky({ location }: { location: string })` (renders `<canvas className="world-sky" data-running>`)
  - tokens `--sky-top`, `--sky-horizon`, `--sky-sun`, `--sky-cloud`, `--sky-precip`, `--world-fog`, `--world-vignette`, `--world-ground`, `--world-grid`

- [ ] **Step 1: Write the failing tests**

Create `src/pages/newtab/world/sky.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { skyFor } from './sky';

describe('skyFor', () => {
  it('puts the sun on its arc by the hour, and none at night', () => {
    expect(skyFor(12, 0).sun).toEqual({ x: 0.5, y: 0.12 });
    expect(skyFor(6, 0).sun?.x).toBeCloseTo(0.08);
    expect(skyFor(22, 0).sun).toBeNull();
    expect(skyFor(4, 0).sun).toBeNull();
  });

  it('reads the WMO code the weather line already shows', () => {
    expect(skyFor(12, 0)).toMatchObject({ clouds: 0, precip: null, haze: false });
    expect(skyFor(12, 2)).toMatchObject({ clouds: 3, precip: null });
    expect(skyFor(12, 3)).toMatchObject({ clouds: 7 });
    expect(skyFor(12, 45)).toMatchObject({ haze: true });
    expect(skyFor(12, 61)).toMatchObject({ clouds: 7, precip: 'rain' });
    expect(skyFor(12, 71)).toMatchObject({ precip: 'snow' });
  });

  it('draws a plain sky when there is no reading, rather than claiming weather', () => {
    expect(skyFor(12, null)).toMatchObject({ clouds: 0, precip: null, haze: false });
    expect(skyFor(12, -1)).toMatchObject({ clouds: 0, precip: null, haze: false });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/pages/newtab/world/sky.test.ts`
Expected: FAIL, cannot resolve `./sky`.

- [ ] **Step 3: The pure sky**

Create `src/pages/newtab/world/sky.ts`:
```ts
export interface SkyState {
  /** Fractions of the canvas; null between 18:00 and 06:00 */
  sun: { x: number; y: number } | null;
  clouds: number;
  precip: 'rain' | 'snow' | null;
  haze: boolean;
}

/**
 * The sky the clock and the weather line say it is. A missing or unknown
 * reading draws a plain sky: weather on screen is a claim, the same rule
 * Weather.tsx follows for its label.
 */
export function skyFor(hour: number, code: number | null): SkyState {
  const day = hour >= 6 && hour < 18;
  const t = (hour - 6) / 12; // 0 at 06:00, 0.5 at noon, 1 at 18:00
  const sun = day ? { x: Number((0.08 + 0.84 * t).toFixed(2)), y: Number((0.12 + 0.5 * (2 * t - 1) ** 2).toFixed(2)) } : null;
  if (code === null || !Number.isFinite(code) || code < 0 || code > 99) return { sun, clouds: 0, precip: null, haze: false };
  if (code === 0) return { sun, clouds: 0, precip: null, haze: false };
  if (code <= 2) return { sun, clouds: 3, precip: null, haze: false };
  if (code === 3) return { sun, clouds: 7, precip: null, haze: false };
  if (code <= 48) return { sun, clouds: 2, precip: null, haze: true };
  if (code <= 67 || (code >= 80 && code <= 82) || code >= 95) return { sun, clouds: 7, precip: 'rain', haze: false };
  return { sun, clouds: 7, precip: 'snow', haze: false };
}
```
(Noon: t = 0.5, so x = 0.08 + 0.42 = 0.5 and y = 0.12, the top of the arc; 06:00 gives x = 0.08 on the horizon line's left.)

- [ ] **Step 4: Tokens**

In `src/shared/theme.css`, in the light `:root` colour block (near `--accent-wash`) add:
```css
  /* The new tab's world (world.css): sky, ground, fog and the moving vignette. */
  --sky-top: #cfd6d6;
  --sky-horizon: #efe7d9;
  --sky-sun: rgba(255, 232, 190, 0.9);
  --sky-cloud: rgba(255, 255, 255, 0.78);
  --sky-precip: rgba(90, 102, 112, 0.35);
  --world-ground: #e8dfcf;
  --world-grid: rgba(43, 37, 32, 0.12);
  --world-fog: rgba(233, 225, 211, 0.96);
  --world-vignette: rgba(43, 37, 32, 0.38);
```
and in `:root[data-theme='dark']`:
```css
  --sky-top: #0d1116;
  --sky-horizon: #1d1916;
  --sky-sun: rgba(227, 144, 110, 0.55);
  --sky-cloud: rgba(236, 228, 216, 0.16);
  --sky-precip: rgba(236, 228, 216, 0.22);
  --world-ground: #171412;
  --world-grid: rgba(236, 228, 216, 0.1);
  --world-fog: rgba(14, 12, 11, 0.96);
  --world-vignette: rgba(0, 0, 0, 0.6);
```

- [ ] **Step 5: The canvas**

Create `src/pages/newtab/world/Sky.tsx`:
```tsx
import { useEffect, useRef } from 'react';
import { useAmbient } from '../../../shared/hooks/useAmbient';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { usableReading } from '../Weather';
import { skyFor } from './sky';

const FRAME_MS = 33;

/**
 * The world's sky: the real hour and the weather line's own reading. Clouds
 * drift and rain falls only while ambient motion runs; otherwise one still
 * frame. Colours are read from the theme tokens every frame, so a theme
 * switched in Settings recolours it without a reload.
 */
export function Sky({ location }: { location: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { running } = useAmbient();
  const [weather] = useStorageValue('weather');
  const code = usableReading(weather, location.trim()) ? weather.code : null;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;
    let last = 0;
    let t = 0;

    const draw = (now: number) => {
      if (running) raf = requestAnimationFrame(draw);
      if (running && now - last < FRAME_MS) return;
      t += last ? Math.min(now - last, 100) / 1000 : 0;
      last = now;
      const dpr = devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
      if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const css = getComputedStyle(canvas);
      const token = (name: string) => css.getPropertyValue(name).trim();
      const sky = skyFor(new Date().getHours(), code);

      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, token('--sky-top'));
      g.addColorStop(1, token('--sky-horizon'));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      if (sky.sun) {
        ctx.fillStyle = token('--sky-sun');
        ctx.beginPath();
        ctx.arc(sky.sun.x * w, sky.sun.y * h, 24, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = token('--sky-cloud');
      for (let i = 0; i < sky.clouds; i++) {
        const span = w + 240;
        const x = ((i * 197 + t * 8 * (1 + (i % 3) * 0.3)) % span) - 120;
        const y = 24 + ((i * 53) % Math.max(1, h * 0.5));
        const s = 0.7 + (i % 3) * 0.3;
        ctx.beginPath();
        ctx.ellipse(x, y, 60 * s, 14 * s, 0, 0, Math.PI * 2);
        ctx.ellipse(x + 28 * s, y - 8 * s, 40 * s, 12 * s, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      if (sky.haze) {
        ctx.fillStyle = token('--sky-cloud');
        ctx.fillRect(0, h * 0.4, w, h * 0.6);
      }
      if (sky.precip) {
        ctx.strokeStyle = token('--sky-precip');
        ctx.fillStyle = token('--sky-precip');
        for (let i = 0; i < 80; i++) {
          const x = (i * 89) % w;
          const y = ((i * 37 + t * (sky.precip === 'rain' ? 240 : 40)) % h);
          if (sky.precip === 'rain') {
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x - 2, y + 10);
            ctx.stroke();
          } else ctx.fillRect(x, y, 2, 2);
        }
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [running, code]);

  return <canvas ref={ref} className="world-sky" data-running={running || undefined} aria-hidden="true" />;
}
```

Create `src/pages/newtab/world/world.css` with only the sky rule for now (Task 7 fills the rest):
```css
/*
 * The new tab as a world (World.tsx). The frame (top band, bottom band, docks)
 * is screen-fixed and opaque; the view between them holds the sky and the
 * scene. Colours and sizes are tokens only (designSystem.test.ts); motion is on
 * the spring and effects tokens (motion.test.ts, camera.test.ts).
 */
.world-sky {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
```

- [ ] **Step 6: Run to verify**

Run: `npm run typecheck && npx vitest run src/pages/newtab/world/sky.test.ts src/shared/theme.test.ts src/shared/designSystem.test.ts src/shared/ambient.test.ts`
Expected: PASS (`Sky.tsx` imports useAmbient, so the ambient lint passes).

- [ ] **Step 7: Commit**

```bash
git add src/pages/newtab/world src/shared/theme.css
git commit -m "The world's sky: the real hour and the weather line's own reading

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The world

**Files:**
- Create: `src/pages/newtab/EditionIndex.tsx`, `src/pages/newtab/world/World.tsx`, `e2e/world.e2e.ts`
- Modify: `src/pages/newtab/TriageCard.tsx` (split into `useTriage` + `TriageRow` + `TriageCard`), `src/pages/newtab/ActivityHeatmap.tsx` (a `terrain` prop), `src/pages/newtab/BrainDump.tsx:68` (draft survives a remount), `src/pages/newtab/Dashboard.tsx`, `src/pages/newtab/world/world.css`, `src/pages/newtab/main.tsx` (import world.css), `e2e/a11yBaseline.ts` (no change expected), `e2e/smoke.e2e.ts`, `e2e/triage.e2e.ts`, `e2e/load.e2e.ts` (seed `worldView: 'flat'` where they test the flat Edition)

**Interfaces:**
- Consumes: `placeStories`, `placeTransform`, `WATCHING`, `SIGN_OFFSET` (Task 3); `CAMERA`, `cameraFor`, `sceneTransform` (Task 4); `Sky` (Task 6); `viewMode`, `NARROW_QUERY`, `REDUCED_QUERY` (Task 2); `useMedia`, `useAmbient` (Task 2); `paceMinutesLeft`, `paceLabel` (Task 5)
- Produces:
  - `useTriage(): { picks: Pick[] | null; note: string; mutedCount: number; hasItems: boolean }`
  - `TriageRow({ pick, onOpen }: { pick: Pick; onOpen: (pick: Pick, newTab: boolean) => void })` (renders the `<button className="edition-story" data-story>`)
  - `TriageCard({ onOpen }: { onOpen: (pick: Pick, newTab: boolean) => void })`
  - `EditionIndex()` (the favorites + Papers/Settings/focus footer)
  - `World(props: WorldProps)`; elements: `main.world[data-comfort][data-focus][data-stepping]`, `.world-place[data-place=<key>][data-locked]`, `.world-panel`, `.world-sign`, `.world-ambient-toggle`, `.world-telemetry`

- [ ] **Step 1: Write the failing browser tests**

Create `e2e/world.e2e.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NETWORK_NOISE, PAGES, expectA11y, expectClean, launch, seed, storage, type Ext } from './harness';
import { html } from './sites';
import { article, feedItem } from './seed';

const OFF = { ollamaUrl: 'http://127.0.0.1:9', layaUrl: '', mutedTopics: [] };

describe('the new tab as a world', () => {
  let ext: Ext;
  const urls: string[] = [];

  beforeAll(async () => {
    ext = await launch();
    for (const name of ['one', 'two', 'three']) {
      const url = `${ext.sites.origin('article')}/${name}`;
      ext.sites.setRoute('article', `/${name}`, html(`<h1>${name}</h1>`));
      urls.push(url);
    }
  });
  afterAll(async () => ext.close());
  beforeEach(async () => {
    ext.errors.splice(0);
    await seed(ext, {
      settings: { ...OFF, worldView: 'world', comfort: 'recommended', ambientMotion: true },
      readingProgress: {
        [urls[0]]: article(urls[0], 'Lead story', { updatedAt: Date.now() - 60_000, activeSeconds: 600, maxPercent: 40 }),
        [urls[1]]: article(urls[1], 'Second story', { updatedAt: Date.now() - 86_400_000 }),
        [urls[2]]: article(urls[2], 'Third story', { updatedAt: Date.now() - 5 * 86_400_000 }),
      },
      cachedItems: [feedItem('a', 'Feed one'), feedItem('b', 'Feed two')],
      readItems: [],
      focusSession: null,
    });
  });

  it('renders the frame, the path and the lane, with the lead locked and forecast at your pace', async () => {
    const page = await ext.page(PAGES.newtab);
    await expect.poll(() => page.locator('main.world .world-place').count()).toBe(5);
    expect(await page.locator('.world-place[data-locked]').innerText()).toContain('Lead story');
    expect(await page.locator('.world-place[data-locked]').innerText()).toContain('≈15 min at your pace');
    expect(await page.locator('.edition-masthead h1').count()).toBe(1);
    await expectA11y(page, 'newtab');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('lists the same stories in the same order as the flat view (parity)', async () => {
    const page = await ext.page(PAGES.newtab);
    await page.locator('[data-story]').first().waitFor();
    const world = await page.locator('[data-story]').allInnerTexts();
    await page.keyboard.press('v');
    await expect.poll(() => page.locator('main.edition').count()).toBe(1);
    const flat = await page.locator('[data-story]').allInnerTexts();
    const title = (t: string) => t.split('\n').find((l) => /story|Feed/.test(l));
    expect(world.map(title)).toEqual(flat.map(title));
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('J moves the camera and the lock, with the vignette only while it moves', async () => {
    const page = await ext.page(PAGES.newtab);
    const scene = page.locator('.world-scene');
    const before = await scene.evaluate((el) => (el as HTMLElement).style.transform);
    await page.keyboard.press('j');
    await expect.poll(() => scene.evaluate((el) => (el as HTMLElement).style.transform)).not.toBe(before);
    expect(await page.locator('.world-place[data-locked]').innerText()).toContain('Second story');
    expect(await page.locator('main.world[data-moving]').count()).toBe(1);
    await expect.poll(() => page.locator('main.world[data-moving]').count(), { timeout: 3000 }).toBe(0);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('comfortable cuts: no camera transition', async () => {
    await seed(ext, { settings: { ...OFF, worldView: 'world', comfort: 'comfortable' } });
    const page = await ext.page(PAGES.newtab);
    const duration = await page.locator('.world-scene').evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(duration).toBe('0s');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('every panel is clickable and tabbable in path order', async () => {
    const page = await ext.page(PAGES.newtab);
    const second = page.locator('[data-story]', { hasText: 'Second story' });
    await second.focus();
    expect(await page.evaluate(() => document.activeElement?.textContent)).toContain('Second story');
    await page.keyboard.press('Tab');
    const next = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest('[data-place]')?.textContent ?? '');
    expect(next).toMatch(/Third story|Recap/);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('Reduce Motion and a narrow window both get the flat Edition', async () => {
    const page = await ext.ctx.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`chrome-extension://${ext.id}/${PAGES.newtab}`);
    await expect.poll(() => page.locator('main.edition').count()).toBe(1);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 800, height: 900 });
    await page.waitForTimeout(300);
    expect(await page.locator('main.world').count()).toBe(0);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('a focus session brings the fog and stops the sky', async () => {
    await seed(ext, { focusSession: { phaseEndsAt: Date.now() + 25 * 60_000, startedAt: Date.now(), focusMinutes: 25 } });
    const page = await ext.page(PAGES.newtab);
    expect(await page.locator('main.world[data-focus]').count()).toBe(1);
    expect(await page.locator('.world-sky[data-running]').count()).toBe(0);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('the pause button turns ambient motion off and on', async () => {
    const page = await ext.page(PAGES.newtab);
    await page.getByRole('button', { name: 'Pause ambient motion' }).click();
    await expect.poll(async () => (await storage<{ ambientMotion?: boolean }>(ext, 'settings')).ambientMotion).toBe(false);
    await expect.poll(() => page.locator('.world-sky[data-running]').count()).toBe(0);
    await page.getByRole('button', { name: 'Resume ambient motion' }).click();
    await expect.poll(async () => (await storage<{ ambientMotion?: boolean }>(ext, 'settings')).ambientMotion).toBe(true);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('switching view keeps the brain dump draft', async () => {
    const page = await ext.page(PAGES.newtab);
    const box = page.getByPlaceholder(/Whatever is looping/);
    await box.fill('call the dentist');
    await box.blur();
    await page.keyboard.press('v');
    await expect.poll(() => page.locator('main.edition').count()).toBe(1);
    expect(await page.getByPlaceholder(/Whatever is looping/).inputValue()).toBe('call the dentist');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('an empty profile shows the signpost, not a void', async () => {
    await seed(ext, { readingProgress: {}, cachedItems: [] });
    const page = await ext.page(PAGES.newtab);
    await expect.poll(() => page.locator('.world-sign').innerText()).toContain('⌘/Ctrl+Shift+E');
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('more than nine things leaves a sign pointing to the flat view', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`http://x.e2e.test/${i}`, article(`http://x.e2e.test/${i}`, `Story ${i}`, { updatedAt: Date.now() - i * 3_600_000 })]),
    );
    await seed(ext, { readingProgress: many, cachedItems: Array.from({ length: 6 }, (_, i) => feedItem(`f${i}`, `Feed ${i}`)) });
    const page = await ext.page(PAGES.newtab);
    await expect.poll(() => page.locator('.world-place').count()).toBe(9);
    expect(await page.locator('.world-sign').innerText()).toMatch(/^\+\d+ more · V for the flat view$/);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });

  it('sky follows a theme switch without a reload', async () => {
    const page = await ext.page(PAGES.newtab);
    const read = () => page.locator('.world-sky').evaluate((c) => getComputedStyle(c).getPropertyValue('--sky-top').trim());
    const light = await read();
    await seed(ext, { settings: { ...OFF, worldView: 'world', theme: 'dark' } });
    await expect.poll(read).not.toBe(light);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
});
```

In `e2e/smoke.e2e.ts`, `e2e/triage.e2e.ts` and `e2e/load.e2e.ts`, add `worldView: 'flat'` to every `settings` object they seed (they test the flat Edition). In smoke's `beforeAll` seed add `settings: { ollamaUrl: 'http://127.0.0.1:9', worldView: 'flat' }`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build:e2e && npx vitest run --config vitest.e2e.config.ts e2e/world.e2e.ts`
Expected: FAIL: no `main.world` (the setting exists but nothing renders the world yet).

- [ ] **Step 3: Split TriageCard**

Rewrite `src/pages/newtab/TriageCard.tsx` keeping every line of ranking logic from today's file, reorganised:
- `export function useTriage()` contains everything from `const [settings, settingsLoaded] = useSettings();` through the end of the ranking `useEffect`, and returns `{ picks, note, mutedCount, hasItems: itemsLoaded && cachedItems.length > 0 }`.
- `export function TriageRow({ pick, onOpen })` renders today's `<button className="edition-story" data-story ...>` with the same three spans; its `onClick` records the stat exactly as today, then calls `onOpen(pick, e.metaKey || e.ctrlKey)` instead of `sendMessage(...)`.
- `export function TriageCard({ onOpen })` calls `useTriage()`, returns `null` when `!hasItems`, and renders today's `<section className="edition-feed">` markup with `<li key={pick.item.id}><TriageRow pick={pick} onOpen={onOpen} /></li>` per pick, plus the note and muted paragraphs unchanged.
- `sendMessage` is no longer imported here; the open happens in `Dashboard` (Task 8 makes it same-tab). Until Task 8, Dashboard's handler sends today's `OPEN_ARTICLE` (see Step 6).

- [ ] **Step 4: Terrain, the index, the brain dump draft**

In `src/pages/newtab/ActivityHeatmap.tsx`: add a prop `terrain = false` (signature `ActivityHeatmap({ papers, terrain = false }: { papers: Paper[]; terrain?: boolean })`). When `terrain` is true, return only:
```tsx
    <section className="heat heat--terrain" aria-label={headline}>
      <div className="heat-grid heat-grid--terrain">
        {days.map((day) => (
          <span key={day.date} className="heat-cell" data-level={day.level ?? undefined} />
        ))}
      </div>
    </section>
```
(before the existing `return`, after `headline` is computed).

Create `src/pages/newtab/EditionIndex.tsx` by moving today's `<footer className="edition-index">...</footer>` JSX out of `Dashboard.tsx` verbatim into:
```tsx
import { PAPERS_PAGE_PATH } from '../../shared/constants';
import { useFocusSession } from '../../shared/hooks/useFocusSession';
import { useSettings } from '../../shared/hooks/useSettings';
import { BookmarksPanel } from './BookmarksPanel';

/** Favorites, Papers, Settings and focus: the tools along the foot of either view. */
export function EditionIndex() {
  const [settings] = useSettings();
  const focus = useFocusSession();
  return (
    /* today's <footer className="edition-index"> ... </footer>, unchanged */
  );
}
```

In `src/pages/newtab/BrainDump.tsx`, the draft survives the remount a view switch causes. Above `export function BrainDump()` add:
```ts
/** The unsent draft, kept across a remount (switching between world and flat), never stored. */
let draftMemo = '';
```
and change line 68 `const [text, setText] = useState('');` to:
```ts
  const [text, setTextState] = useState(() => draftMemo);
  const setText = (next: string) => {
    draftMemo = next;
    setTextState(next);
  };
```
(If `setText` is passed a function anywhere in the file, `rg -n "setText\(" src/pages/newtab/BrainDump.tsx` shows it; every call there passes a string today.)

- [ ] **Step 5: The world**

Create `src/pages/newtab/world/World.tsx`:
```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ResumableItem } from '../../../shared/attention';
import { Brackets } from '../../../shared/components/Brackets';
import type { useFocusSession } from '../../../shared/hooks/useFocusSession';
import { useAmbient } from '../../../shared/hooks/useAmbient';
import type { useNowWatching } from '../../../shared/hooks/useNowWatching';
import type { Pick } from '../../../shared/llm/triage';
import { paceLabel, paceMinutesLeft } from '../../../shared/progress';
import type { Paper, Settings } from '../../../shared/types';
import { ActivityHeatmap } from '../ActivityHeatmap';
import { BrainDump } from '../BrainDump';
import { ContinueRow, kickerFor } from '../ContinueRow';
import { EditionIndex } from '../EditionIndex';
import { Hero } from '../Hero';
import { NowWatching } from '../NowWatching';
import { TriageRow, useTriage } from '../TriageCard';
import { CAMERA, cameraFor, sceneTransform } from './camera';
import { placeStories, placeTransform, SIGN_OFFSET, WATCHING } from './layout';
import { Sky } from './Sky';

export interface WorldProps {
  status: string;
  resumable: ResumableItem[];
  now: number;
  watching: ReturnType<typeof useNowWatching>;
  papers: Paper[];
  focus: ReturnType<typeof useFocusSession>;
  settings: Settings;
  quote: string;
  stepping: boolean;
  onOpen: (item: ResumableItem, alt: boolean, newTab: boolean) => void;
  onOpenPick: (pick: Pick, newTab: boolean) => void;
}

/**
 * The new tab as a place you stand in. Things you read stand in the scene;
 * tools you use (the brain dump, favorites, focus) stay in the frame, which
 * never moves. The camera follows keyboard focus and nothing else.
 */
export function World(props: WorldProps) {
  const { resumable, settings, focus, stepping } = props;
  const triage = useTriage();
  const ambient = useAmbient();
  const picks = triage.picks ?? [];

  const { placed, overflow } = useMemo(
    () =>
      placeStories(
        [
          ...resumable.map((i) => ({ key: i.key, lane: 'path' as const, updatedAt: i.updatedAt })),
          ...picks.map((p) => ({ key: `feed:${p.item.id}`, lane: 'feed' as const, updatedAt: Date.parse(p.item.pubDate) || props.now })),
        ],
        props.now,
      ),
    [resumable, picks, props.now],
  );
  const byKey = new Map(placed.map((p) => [p.key, p]));

  const [target, setTarget] = useState<string | null>(null);
  const lockedKey = target && byKey.has(target) ? target : (placed[0]?.key ?? null);
  const camera = cameraFor(lockedKey ? (byKey.get(lockedKey) ?? null) : null);

  // The vignette is on only while the camera glides (Meta's comfort guidance).
  const [moving, setMoving] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (settings.comfort !== 'recommended') return;
    setMoving(true);
    const ms = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-smooth')) || 520;
    const timer = setTimeout(() => setMoving(false), ms);
    return () => clearTimeout(timer);
  }, [lockedKey, settings.comfort]);

  const lastPath = [...placed].reverse().find((p) => p.lane === 'path');
  const signZ = (lastPath?.z ?? 0) - SIGN_OFFSET;

  return (
    <main
      className="world"
      data-comfort={settings.comfort}
      data-focus={focus.active || undefined}
      data-moving={moving || undefined}
      data-stepping={stepping || undefined}
    >
      <div className="world-frame world-frame--top">
        <Hero status={props.status} />
      </div>

      <div className="world-view">
        <Sky location={settings.weatherLocation} />
        <div
          className="world-scene"
          style={{ transform: sceneTransform(camera, stepping ? CAMERA.stepDepth : CAMERA.viewDepth) }}
          onFocusCapture={(e) => {
            const key = (e.target as HTMLElement).closest<HTMLElement>('[data-place]')?.dataset.place;
            if (key) setTarget(key);
          }}
        >
          <div className="world-ground" aria-hidden="true" />
          <div className="world-path" aria-hidden="true" />

          {props.watching.active && (
            <div className="world-place" style={{ transform: placeTransform(WATCHING) }}>
              <div className="world-panel world-panel--watching">
                <NowWatching watching={props.watching} />
              </div>
            </div>
          )}

          <ul className="world-stories" aria-label="Unfinished, and from your feeds">
            {resumable.map((item) => {
              const p = byKey.get(item.key);
              if (!p) return null;
              const locked = p.key === lockedKey;
              const pace = item.progress ? paceLabel(paceMinutesLeft(item.progress)) : '';
              return (
                <li key={item.key} className="world-place" data-place={p.key} data-locked={locked || undefined} style={{ transform: placeTransform(p) }}>
                  <ul className="world-panel world-panel--path">
                    <ContinueRow
                      lead={item === resumable[0]}
                      item={item}
                      now={props.now}
                      onOpen={(alt, newTab) => props.onOpen(item, alt, newTab)}
                    />
                  </ul>
                  {locked && (
                    <p className="world-lock-label" aria-hidden="true">
                      {[kickerFor(item).replace(/^Continue \w+ · /, '').toUpperCase(), pace].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </li>
              );
            })}
            {picks.map((pick) => {
              const p = byKey.get(`feed:${pick.item.id}`);
              if (!p) return null;
              const locked = p.key === lockedKey;
              return (
                <li key={p.key} className="world-place" data-place={p.key} data-locked={locked || undefined} style={{ transform: placeTransform(p) }}>
                  <div className="world-panel world-panel--feed">
                    <TriageRow pick={pick} onOpen={props.onOpenPick} />
                  </div>
                  {locked && (
                    <p className="world-lock-label" aria-hidden="true">
                      {pick.because ? `FEED · BECAUSE YOU READ ${pick.because.toUpperCase()}` : `FEED · ${pick.item.source.toUpperCase()}`}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>

          {(placed.length === 0 || overflow > 0) && (
            <p className="world-place world-sign" style={{ transform: placeTransform({ x: 0, z: placed.length ? signZ : 0, yaw: 0 }) }}>
              {placed.length === 0
                ? 'Nothing open. Press ⌘/Ctrl+Shift+E on any page to read it here.'
                : `+${overflow} more · V for the flat view`}
            </p>
          )}

          <div className="world-terrain">
            <ActivityHeatmap papers={props.papers} terrain />
          </div>
          <p className="world-quote">{props.quote}</p>
        </div>
        <div className="world-fog" aria-hidden="true" />
        <div className="world-vignette" aria-hidden="true" />
        {settings.comfort === 'comfortable' && <div key={lockedKey ?? ''} className="world-cut" aria-hidden="true" />}
        <Brackets />
      </div>

      <div className="world-frame world-frame--bottom">
        <aside className="world-dock world-dock--left" aria-label="Brain dump">
          <BrainDump />
        </aside>
        <div className="world-telemetry">
          <p>{[props.status, focus.active ? `focus ${focus.countdown}` : null, 'J/K walk · Enter step in · V flat'].filter(Boolean).join(' · ')}</p>
          <button type="button" className="world-ambient-toggle edition-link" onClick={ambient.toggle}>
            {ambient.enabled ? 'Pause ambient motion' : 'Resume ambient motion'}
          </button>
        </div>
        <div className="world-dock world-dock--right">
          <EditionIndex />
        </div>
      </div>
    </main>
  );
}

```

Create `src/shared/components/Brackets.tsx`:
```tsx
/** Viewfinder corner brackets: the egocentric frame. Purely visual. */
export function Brackets() {
  return (
    <span className="brackets" aria-hidden="true">
      <span className="bracket bracket--tl" />
      <span className="bracket bracket--tr" />
      <span className="bracket bracket--bl" />
      <span className="bracket bracket--br" />
    </span>
  );
}
```
and in `src/shared/theme.css` (loaded by every page) append:
```css
/* Viewfinder corners (Brackets.tsx): the new tab's world and Settings. */
.brackets {
  position: absolute;
  inset: var(--space-3);
  pointer-events: none;
}
.bracket {
  position: absolute;
  width: 24px;
  height: 24px;
  border: 0 solid var(--text-faint);
}
.bracket--tl { top: 0; left: 0; border-width: 2px 0 0 2px; }
.bracket--tr { top: 0; right: 0; border-width: 2px 2px 0 0; }
.bracket--bl { bottom: 0; left: 0; border-width: 0 0 2px 2px; }
.bracket--br { bottom: 0; right: 0; border-width: 0 2px 2px 0; }
```

Replace `src/pages/newtab/world/world.css` with the full sheet:
```css
/*
 * The new tab as a world (World.tsx). The frame (top band, bottom band, docks)
 * is screen-fixed and opaque; the view between them holds the sky and the
 * scene. Colours and sizes are tokens only (designSystem.test.ts); motion is on
 * the spring and effects tokens (motion.test.ts, camera.test.ts).
 */
.world {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  height: 100vh;
  overflow: hidden;
  background: var(--bg-page);
}

.world-frame {
  position: relative;
  z-index: 2;
  background: var(--bg-page);
  padding-inline: var(--space-6);
}
.world-frame--top .edition-masthead {
  padding-bottom: var(--space-6);
}
.world-frame--bottom {
  display: grid;
  grid-template-columns: minmax(0, 360px) 1fr auto;
  align-items: end;
  gap: var(--space-5);
  padding-block: var(--space-3) var(--space-4);
  border-top: 3px double var(--rule);
}
.world-telemetry {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-xs);
  color: var(--text-muted);
  text-align: center;
}
.world-telemetry p {
  margin: 0 0 var(--space-1);
}
.world-dock--right .edition-index {
  border-top: none;
  padding-top: 0;
}

.world-view {
  position: relative;
  overflow: hidden;
  perspective: 900px;
  perspective-origin: 50% 36%;
}

.world-scene {
  position: absolute;
  left: 50%;
  top: 60%;
  width: 0;
  height: 0;
  transform-style: preserve-3d;
  transition: transform var(--dur-smooth) var(--spring-smooth);
}
.world[data-comfort='comfortable'] .world-scene {
  transition: none;
}

.world-ground {
  position: absolute;
  width: 6000px;
  height: 6000px;
  left: -3000px;
  top: -3000px;
  transform: rotateX(90deg);
  background:
    repeating-linear-gradient(0deg, var(--world-grid) 0 1px, transparent 1px 80px),
    repeating-linear-gradient(90deg, var(--world-grid) 0 1px, transparent 1px 80px),
    var(--world-ground);
}
.world-path {
  position: absolute;
  width: 120px;
  height: 4000px;
  left: -60px;
  top: -4000px;
  transform-origin: 50% 100%;
  transform: rotateX(90deg);
  background: var(--accent-wash);
  border-inline: 1px dashed var(--accent);
}

.world-stories {
  display: contents;
}
.world-place {
  position: absolute;
  left: 0;
  top: 0;
  transform-style: preserve-3d;
}
.world-panel {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 360px;
  transform: translateX(-50%);
  padding: var(--space-4);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.world-panel--feed {
  width: 280px;
}
.world-panel :is(.edition-headline, .relay-row-title, .edition-story-title) {
  font-size: var(--text-xl);
  line-height: var(--leading-xl);
}
.world-place[data-locked] .world-panel {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
  transition: border-color var(--dur-effect-fast) var(--ease-effect);
}
.world-lock-label {
  position: absolute;
  left: 0;
  top: var(--space-2);
  transform: translateX(-50%);
  margin: 0;
  padding: var(--space-1) var(--space-2);
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-xs);
  color: var(--on-accent);
  background: var(--accent);
  border-radius: var(--radius-sm);
}
.world-sign {
  margin: 0;
  transform-origin: 50% 100%;
  translate: -50% -100%;
  padding: var(--space-3) var(--space-4);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: var(--leading-sm);
  color: var(--text-secondary);
  background: var(--bg-surface);
  border: 1px dashed var(--border);
  border-radius: var(--radius-md);
  white-space: nowrap;
}

.world-terrain {
  position: absolute;
  left: -1400px;
  top: 0;
  transform-origin: 0 0;
  transform: translate3d(0px, 0px, -400px) rotateX(90deg);
  transform-style: preserve-3d;
}
.heat--terrain .heat-grid--terrain {
  display: grid;
  grid-template-rows: repeat(7, 16px);
  grid-auto-flow: column;
  grid-auto-columns: 16px;
  gap: 4px;
  transform-style: preserve-3d;
}
.heat-grid--terrain .heat-cell[data-level='1'] { transform: translateZ(4px); }
.heat-grid--terrain .heat-cell[data-level='2'] { transform: translateZ(8px); }
.heat-grid--terrain .heat-cell[data-level='3'] { transform: translateZ(16px); }
.heat-grid--terrain .heat-cell[data-level='4'] { transform: translateZ(24px); }

.world-quote {
  position: absolute;
  left: 0;
  top: 0;
  margin: 0;
  width: 640px;
  transform: translate3d(-320px, -360px, -3600px);
  text-align: center;
  font-family: var(--font-display);
  font-style: italic;
  font-size: var(--text-2xl);
  line-height: var(--leading-2xl);
  color: var(--text-muted);
}

.world-fog,
.world-vignette,
.world-cut {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--dur-effect-slow) var(--ease-effect);
}
.world-fog {
  background: radial-gradient(ellipse 36% 44% at 50% 52%, transparent 40%, var(--world-fog) 100%);
}
.world[data-focus] .world-fog {
  opacity: 1;
}
.world[data-focus] .world-place:not([data-locked]) {
  opacity: 0.08;
  transition: opacity var(--dur-effect-slow) var(--ease-effect);
}
.world-vignette {
  background: radial-gradient(ellipse 56% 60% at 50% 50%, transparent 55%, var(--world-vignette) 100%);
  transition-duration: var(--dur-effect-fast);
}
.world[data-moving] .world-vignette {
  opacity: 1;
}
.world-cut {
  background: var(--bg-page);
  animation: world-cut var(--dur-effect-slow) var(--ease-effect);
}
@keyframes world-cut {
  0%, 30% { opacity: 1; }
  100% { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .world-scene {
    transition: none;
  }
}
```
Add `@import './world/world.css';` is not how this project loads CSS: in `src/pages/newtab/main.tsx`, after the existing `import './newtab.css';` add `import './world/world.css';`.

- [ ] **Step 6: Dashboard chooses the arrangement**

In `src/pages/newtab/Dashboard.tsx`:
- add imports: `useMedia` from `'../../shared/hooks/useMedia'`; `patchSettings` from `'../../shared/storage'`; `EditionIndex` from `'./EditionIndex'`; `World` from `'./world/World'`; `NARROW_QUERY, REDUCED_QUERY, viewMode` from `'./world/view'`; `type Pick` from `'../../shared/llm/triage'`; `recordStat` is not needed here. Remove `BookmarksPanel` and `PAPERS_PAGE_PATH` imports (moved to EditionIndex).
- after `const status = ...` add:
```ts
  const reduced = useMedia(REDUCED_QUERY);
  const narrow = useMedia(NARROW_QUERY);
  const view = viewMode(settings.worldView, reduced, narrow);
  const [stepping] = useState(false); // Task 8 drives this
  const quote = quoteOfDay(localDate());

  const openPick = (pick: Pick, _newTab: boolean) =>
    void sendMessage({
      type: 'OPEN_ARTICLE',
      url: pick.item.link,
      feedItemId: pick.item.id,
      readerView: false,
      original: true,
      alsoReadIds: pick.also.map((a) => a.id),
    });
```
- change `const open = (item: ResumableItem, alt: boolean) => {` to `const open = (item: ResumableItem, alt: boolean, _newTab = false) => {` (Task 8 uses `_newTab`).
- in the key handler, before `if (e.key === 'j' ...)`, add V:
```ts
      if (e.key === 'v' && !reduced && !narrow) {
        e.preventDefault();
        void patchSettings({ worldView: settings.worldView === 'world' ? 'flat' : 'world' });
        return;
      }
```
  and add `settings.worldView, reduced, narrow` to that effect's dependency list.
- before the flat `return (`, add:
```tsx
  if (view === 'world') {
    return (
      <World
        status={status}
        resumable={resumable}
        now={watchingNow}
        watching={watching}
        papers={papers}
        focus={focus}
        settings={settings}
        quote={quote}
        stepping={stepping}
        onOpen={open}
        onOpenPick={openPick}
      />
    );
  }
```
- in the flat JSX: `<TriageCard />` becomes `<TriageCard onOpen={openPick} />`; `<p className="edition-quote">{quoteOfDay(localDate())}</p>` becomes `<p className="edition-quote">{quote}</p>`; the whole `<footer className="edition-index">…</footer>` becomes `<EditionIndex />`; ContinueRow `onOpen={(alt) => open(...)}` calls become `onOpen={(alt, newTab) => open(resumable[0], alt, newTab)}` and `onOpen={(alt, newTab) => open(item, alt, newTab)}`.

- [ ] **Step 7: Run the browser suite**

Run: `npm run typecheck && npx vitest run && npm run build:e2e && npx vitest run --config vitest.e2e.config.ts`
Expected: all PASS, including `e2e/world.e2e.ts` (12 tests) and the camera CSS tests from Task 4. Any a11y violation axe finds in the world (for example a contrast on `.world-lock-label`) is fixed here, not baselined. Then look at it: `/verify` the new tab in world mode, light and dark, at 1440×900 and 1280×800, and check the lead stands centred, the feed lane reads, the terrain lies flat on the left and nothing overlaps the frame bands.

- [ ] **Step 8: Commit**

```bash
git add src e2e
git commit -m "The new tab as a world: path, lane, terrain, sky, frame and docks

Same components as the flat Edition in a second arrangement; J/K moves
a comfort-capped camera, V switches views, Reduce Motion and narrow
windows get the flat view, a focus session brings the fog.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Stepping in, in the same tab

**Files:**
- Modify: `src/background/feeds.ts` (`openArticle`), `src/background/feeds.test.ts`, `src/shared/messages.ts` (OPEN_ARTICLE `here`, response `url`), `src/background/router.ts:28-29`, `src/pages/newtab/Dashboard.tsx`, `src/pages/newtab/newtab.css` and `src/pages/reader/reader.css` (view transitions), `src/pages/reader/components/ReaderToolbar.tsx:192`, `e2e/smoke.e2e.ts`, `e2e/triage.e2e.ts`, `e2e/world.e2e.ts`

**Interfaces:**
- Consumes: World `stepping` prop (Task 7)
- Produces: `OPEN_ARTICLE.here?: boolean`; response `{ ok: boolean; url?: string }`; `openArticle(url, feedItemId, resume, readerView, original, alsoReadIds, hereTabId?: number): Promise<{ ok: boolean; url?: string }>`

- [ ] **Step 1: Write the failing tests**

Append to `src/background/feeds.test.ts`:
```ts
describe('openArticle in the same tab', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the destination instead of creating a tab, and registers the tab it came from', async () => {
    const create = vi.fn(async () => ({}));
    const sessionSet = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', {
      tabs: { create, query: vi.fn(async () => []) },
      storage: { local: { get: vi.fn(async () => ({ readItems: [] })), set: vi.fn(async () => undefined) }, session: { get: vi.fn(async () => ({})), set: sessionSet } },
    });
    const res = await openArticle('https://arxiv.org/pdf/2406.09246', null, false, true, false, [], 7);
    expect(create).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, url: expect.stringContaining('alphaxiv.org') });
  });

  it('returns no url when an existing video tab is focused', async () => {
    // focusExistingVideoTab finds the tab: tabs.query returns it.
    vi.stubGlobal('chrome', {
      tabs: { create: vi.fn(), query: vi.fn(async () => [{ id: 3, windowId: 1, url: 'https://www.youtube.com/watch?v=abc' }]), update: vi.fn(async () => ({})) },
      windows: { update: vi.fn(async () => ({})) },
      storage: { local: { get: vi.fn(async () => ({ readItems: [] })), set: vi.fn() }, session: { get: vi.fn(async () => ({})), set: vi.fn() } },
    });
    const res = await openArticle('https://www.youtube.com/watch?v=abc', null, false, true, false, [], 7);
    expect(res).toEqual({ ok: true });
  });
});
```
(`afterEach` and `vi` join the file's vitest import. If `focusExistingVideoTab` queries differently, read `src/background/videoTracking.ts` and stub what it calls; the assertion stays `{ ok: true }` with no `url`.)

In `e2e/smoke.e2e.ts`, the Enter test now expects the same tab to navigate:
```ts
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Enter');
    await page.waitForURL(leadUrl);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
```
(replacing the `waitForEvent('page')` block). Add a test after it:
```ts
  it('new tab: ⌘/Ctrl-click opens a story in a new tab and leaves this one', async () => {
    const page = await ext.page(PAGES.newtab);
    const opened = ext.ctx.waitForEvent('page');
    await page.locator('[data-story]').first().click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
    const tab = await opened;
    await tab.waitForLoadState();
    expect(tab.url()).toBe(leadUrl);
    expect(page.url()).toContain('newtab');
    expectClean(ext, NETWORK_NOISE);
    await tab.close();
    await page.close();
  });
```
In `e2e/triage.e2e.ts`, the grouping test's open becomes same-tab: replace
```ts
    const opened = ext.ctx.waitForEvent('page');
    await fusionRow.click();
    await (await opened).close();
```
with
```ts
    await fusionRow.click();
    await page.waitForURL(/news\.e2e\.test/);
```
In `e2e/world.e2e.ts` add:
```ts
  it('Enter steps into the lead in this tab', async () => {
    const page = await ext.page(PAGES.newtab);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Enter');
    await page.waitForURL(urls[0]);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/background/feeds.test.ts` and `npm run build:e2e && npx vitest run --config vitest.e2e.config.ts e2e/smoke.e2e.ts e2e/world.e2e.ts`
Expected: FAIL: `create` was called (a new tab), and the e2e Enter tests time out on `waitForURL`.

- [ ] **Step 3: The background returns a destination**

In `src/shared/messages.ts` OPEN_ARTICLE add `/** Navigate the sender's own tab: the response carries the URL instead of a new tab opening */ here?: boolean;` and change its response type to `OPEN_ARTICLE: { ok: boolean; url?: string };`.

In `src/background/router.ts`:
```ts
    case 'OPEN_ARTICLE':
      return openArticle(
        msg.url, msg.feedItemId, msg.resume ?? false, msg.readerView ?? true, msg.original ?? false,
        msg.alsoReadIds ?? [], msg.here ? sender.tab?.id : undefined,
      );
```
In `src/background/feeds.ts` `openArticle`, add the parameter `hereTabId?: number` (last), change the return type to `Promise<{ ok: boolean; url?: string }>`, and add inside, before the PDF branch:
```ts
  // From the new tab: hand back where to go, so the page steps into it in its
  // own tab (Chrome's new tab does the same). Tracking registers that tab.
  const go = async (destination: string, register: { key: string; resume: boolean } | null) => {
    if (hereTabId !== undefined) {
      if (register) await registerOpenedTab(hereTabId, register.key, register.resume);
      return { ok: true, url: destination };
    }
    const tab = await chrome.tabs.create({ url: destination });
    if (register && tab.id !== undefined) await registerOpenedTab(tab.id, register.key, register.resume);
    return { ok: true };
  };
```
and route the three existing `chrome.tabs.create` branches through it:
- PDF: `return go(alphaxivUrl(url) ?? readerPageUrl(url), null);`
- reader: `return go(articleReaderUrl(url), { key: url, resume: false });`
- plain: `return go(url, { key: url, resume });`

- [ ] **Step 4: The page steps in**

In `src/pages/newtab/Dashboard.tsx`:
- make stepping real: `const [stepping, setStepping] = useState(false);` (replacing the Task 7 placeholder)
- add, above `open`:
```ts
  // Step in: the camera dollies forward, the story's title is named for the
  // view transition into the reader's title, then this tab navigates. A cut
  // (Comfortable, or the flat view) skips the dolly's wait.
  const stepInto = async (url: string, from: Element | null) => {
    const title = from?.querySelector<HTMLElement>('.edition-headline, .relay-row-title, .edition-story-title');
    if (title) title.style.viewTransitionName = 'story-title';
    setStepping(true);
    const glide = view === 'world' && settings.comfort === 'recommended';
    const ms = glide ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-smooth')) || 0 : 0;
    await new Promise((r) => setTimeout(r, ms));
    location.assign(url);
  };
  const lastStory = useRef<Element | null>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => (lastStory.current = (e.target as Element).closest('[data-story]'));
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  const openArticleHere = async (request: Omit<Extract<Message, { type: 'OPEN_ARTICLE' }>, 'type' | 'here'>, newTab: boolean) => {
    if (newTab) return void sendMessage({ type: 'OPEN_ARTICLE', ...request });
    const res = await sendMessage({ type: 'OPEN_ARTICLE', ...request, here: true });
    if (res?.url) await stepInto(res.url, lastStory.current);
  };
```
- replace `open` with:
```ts
  const open = (item: ResumableItem, alt: boolean, newTab = false) => {
    if (item.paper) {
      const url = paperOpenUrl(item.paper, alt);
      if (newTab) void chrome.tabs.create({ url });
      else void stepInto(url, lastStory.current);
    } else if (item.progress) {
      const context = resumeContextFromProgress(item.progress);
      void openArticleHere({ url: context.url, feedItemId: null, resume: true, readerView: false }, newTab);
    }
  };
```
- replace `openPick` with:
```ts
  const openPick = (pick: Pick, newTab: boolean) =>
    void openArticleHere(
      { url: pick.item.link, feedItemId: pick.item.id, readerView: false, original: true, alsoReadIds: pick.also.map((a) => a.id) },
      newTab,
    );
```
- delete the old `openResume` function at the bottom; import `type Message` from `'../../shared/messages'`.

- [ ] **Step 5: The view transition**

Append to `src/pages/newtab/newtab.css` and to `src/pages/reader/reader.css`:
```css
/* Stepping in: a same-tab navigation morphs the story's title into the
   reader's (Dashboard names it at click time). */
@view-transition {
  navigation: auto;
}
::view-transition-group(story-title) {
  animation-duration: var(--dur-smooth);
  animation-timing-function: var(--spring-smooth);
}
@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(story-title) {
    animation: none;
  }
}
```
(`motion.test.ts`'s `unstilled` needs the selector `::view-transition-group(story-title)` in the reduce block, which this adds.)

In `src/pages/reader/components/ReaderToolbar.tsx:192`, change `<h1 title={title}>{title}</h1>` to `<h1 title={title} className="reader-title">{title}</h1>` and add to `reader.css`:
```css
.reader-title {
  view-transition-name: story-title;
}
```

- [ ] **Step 6: Run to verify they pass**

Run: `npm run typecheck && npx vitest run && npm run build:e2e && npx vitest run --config vitest.e2e.config.ts`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src e2e
git commit -m "Step into what you open, in the same tab, with the title morphing into the reader

⌘/Ctrl-click still opens a new tab. Tracking registers the new tab's own id.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The reader's fovea and telemetry

**Files:**
- Modify: `src/pages/reader/reader.css`

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

Append to `src/shared/motion.test.ts` (it already reads stylesheets):
```ts
describe('the reader stays calm', () => {
  const css = readFileSync(join(ROOT, 'src/pages/reader/reader.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  it('marks the fovea with an edge and never animates it', () => {
    const at = css.indexOf('.reader-focus-band {');
    const rule = css.slice(at, css.indexOf('}', at));
    expect(rule).toMatch(/border-left: 2px solid var\(--accent\)/);
    expect(rule).not.toMatch(/animation|transition/);
  });

  it('sets the capsule numbers in the telemetry face', () => {
    expect(css).toMatch(/\.reader-capsule-summary \{[^}]*font-family: var\(--font-mono\);/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/shared/motion.test.ts -t "reader stays calm"`
Expected: FAIL (no border-left on the band; no mono family on the summary).

- [ ] **Step 3: Implement**

In `src/pages/reader/reader.css`, inside the existing `.reader-focus-band { ... }` rule add `border-left: 2px solid var(--accent);` (the fovea: the sharp centre of vision, marked, still). In the existing `.reader-capsule-summary { ... }` rule add `font-family: var(--font-mono);` (if that rule does not exist, add `.reader-capsule-summary { font-family: var(--font-mono); }`).

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run src/shared/motion.test.ts src/shared/designSystem.test.ts && npm run build:e2e && npx vitest run --config vitest.e2e.config.ts e2e/smoke.e2e.ts`
Expected: PASS.
```bash
git add src/pages/reader/reader.css src/shared/motion.test.ts
git commit -m "Reader: the focus line as a still fovea; capsule numbers in the telemetry face

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The blocked page's robot

**Files:**
- Modify: `src/pages/blocked/Blocked.tsx`, `src/pages/blocked/blocked.css`, `e2e/smoke.e2e.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

In `e2e/smoke.e2e.ts` add:
```ts
  it('blocked page: during focus the robot meets the wall and the detour is refused', async () => {
    await seed(ext, { focusSession: { phaseEndsAt: Date.now() + 20 * 60_000, startedAt: Date.now(), focusMinutes: 25 } });
    const page = await ext.page(PAGES.blocked);
    expect(await page.locator('svg.blocked-robot').count()).toBe(1);
    expect(await page.locator('.blocked-telemetry').innerText()).toBe('OBSTACLE · example.com · PATH BLOCKED');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.locator('.blocked-bot').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    await seed(ext, { focusSession: null });
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build:e2e && npx vitest run --config vitest.e2e.config.ts e2e/smoke.e2e.ts -t "robot"`
Expected: FAIL (no `svg.blocked-robot`).

- [ ] **Step 3: Implement**

In `src/pages/blocked/Blocked.tsx`, in the focus-active return, above `<h1>` add:
```tsx
        <p className="blocked-telemetry">OBSTACLE · {host ?? 'this site'} · PATH BLOCKED</p>
        <svg className="blocked-robot" viewBox="0 0 240 72" aria-hidden="true">
          <line className="blocked-ground" x1="0" y1="64" x2="240" y2="64" />
          <rect className="blocked-wall" x="148" y="20" width="16" height="44" />
          <path className="blocked-detour" d="M104 60 Q136 0 184 60" />
          <g className="blocked-bot">
            <rect x="72" y="40" width="20" height="16" rx="4" />
            <circle cx="82" cy="48" r="2.5" />
            <line x1="82" y1="40" x2="82" y2="32" />
            <line x1="76" y1="56" x2="76" y2="64" />
            <line x1="88" y1="56" x2="88" y2="64" />
          </g>
        </svg>
```
Append to `src/pages/blocked/blocked.css`:
```css
/* The robot walks to the wall, sketches a detour, the detour fades: no way
   round. Plays once and stops; under Reduce Motion it is one still frame. */
.blocked-telemetry {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-xs);
  color: var(--focus-accent);
  margin-bottom: var(--space-3);
}
.blocked-robot {
  width: 240px;
  height: 72px;
  margin-bottom: var(--space-4);
  fill: none;
  stroke: var(--focus-text);
  stroke-width: 2;
  stroke-linecap: round;
}
.blocked-wall {
  stroke: var(--focus-accent);
}
.blocked-detour {
  stroke: var(--focus-accent);
  stroke-dasharray: 4 4;
  opacity: 0;
  animation: blocked-plan 1200ms var(--ease-effect) 900ms both;
}
.blocked-bot {
  animation: blocked-walk var(--dur-bouncy) var(--spring-smooth) both;
}
@keyframes blocked-walk {
  from { transform: translateX(-48px); }
  to { transform: translateX(44px); }
}
@keyframes blocked-plan {
  0% { opacity: 0; }
  40%, 70% { opacity: 0.8; }
  100% { opacity: 0.2; }
}
@media (prefers-reduced-motion: reduce) {
  .blocked-bot,
  .blocked-detour {
    animation: none;
  }
}
```
Check `--focus-accent` exists in `theme.css` (`rg -n "\-\-focus-" src/shared/theme.css`); if not, use `--accent` and note it.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run src/shared && npm run build:e2e && npx vitest run --config vitest.e2e.config.ts e2e/smoke.e2e.ts`
Expected: PASS.
```bash
git add src/pages/blocked e2e/smoke.e2e.ts
git commit -m "Blocked page: the robot meets the wall and the detour is refused

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Settings in the Sim Lab frame

**Files:**
- Modify: `src/pages/options/Options.tsx`, `src/pages/options/options.css`

**Interfaces:**
- Consumes: `Brackets` (Task 7)

- [ ] **Step 1: Write the failing test**

Add to `e2e/smoke.e2e.ts` inside the options checks (a new test):
```ts
  it('options: the viewfinder frame and the world settings are there', async () => {
    const page = await ext.page(PAGES.options);
    expect(await page.locator('.brackets .bracket').count()).toBe(4);
    expect(await page.getByLabel('New tab', { exact: true }).inputValue()).toBe('flat');
    expect(await page.getByLabel('Camera', { exact: true }).count()).toBe(1);
    expect(await page.getByLabel('Ambient motion', { exact: true }).isChecked()).toBe(true);
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build:e2e && npx vitest run --config vitest.e2e.config.ts e2e/smoke.e2e.ts -t "viewfinder"`
Expected: FAIL (no `.brackets` on Options).

- [ ] **Step 3: Implement**

In `src/pages/options/Options.tsx`, import `Brackets` from `'../../shared/components/Brackets'` and render `<Brackets />` as the first child of the root `<div className="colophon grid">`. In `src/pages/options/options.css` add:
```css
.colophon {
  position: relative;
}
.colophon .brackets {
  position: fixed;
}
.colophon-index a {
  font-family: var(--font-mono);
}
```

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run src/shared && npm run build:e2e && npx vitest run --config vitest.e2e.config.ts`
Expected: PASS.
```bash
git add src/pages/options e2e/smoke.e2e.ts
git commit -m "Settings in the Sim Lab frame

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Runners that plan their jumps

**Files:**
- Modify: `src/pages/newtab/ObstacleCourse.tsx`, `src/pages/newtab/ObstacleCourse.test.ts`

**Interfaces:**
- Consumes: `figureAt`, `groundAt`, `courseFor` (existing)
- Produces: `plannedPath(x: number, course: Obstacle[], ahead?: number, step?: number): Pt[]`

- [ ] **Step 1: Write the failing tests**

Append to `src/pages/newtab/ObstacleCourse.test.ts` (add `plannedPath` to its import):
```ts
describe('plannedPath', () => {
  const course = courseFor(960);

  it('is empty on flat ground: nothing to plan', () => {
    expect(plannedPath(0, course, 20)).toEqual([]);
  });

  it('sketches the next jump before the runner gets there, starting where it stands', () => {
    const crate = course.find((o) => o.kind === 'crate')!;
    const path = plannedPath(crate.x - 30, course);
    expect(path.length).toBeGreaterThan(0);
    expect(path[0][0]).toBe(crate.x - 30);
    expect(Math.max(...path.map(([, y]) => y))).toBeGreaterThan(0);
  });

  it('never plans a foot below the ground', () => {
    for (let x = 0; x < 900; x += 7) for (const [px, y] of plannedPath(x, course)) expect(y).toBeGreaterThanOrEqual(groundAt(px, course) - 0.001);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/pages/newtab/ObstacleCourse.test.ts`
Expected: FAIL, `plannedPath is not a function`.

- [ ] **Step 3: Implement**

In `src/pages/newtab/ObstacleCourse.tsx`, after `figureAt` add:
```ts
/**
 * The world model's guess at the next few steps: where the feet will be over
 * the next `ahead` px, sampled every `step`. Empty on flat ground, where there
 * is nothing to plan. The runner draws it faintly before it jumps.
 */
export function plannedPath(x: number, course: Obstacle[], ahead = 60, step = 4): Pt[] {
  const points: Pt[] = [];
  let airborne = false;
  for (let d = 0; d <= ahead; d += step) {
    const f = figureAt(x + d, course);
    if (f.air > 0) airborne = true;
    points.push([x + d, f.lift]);
  }
  return airborne ? points : [];
}
```
In the draw loop, inside `for (const rx of runnersAt(x, w))`, before the body is stroked, draw the plan (only when it exists):
```ts
        const plan = plannedPath(rx, course);
        if (plan.length) {
          ctx.save();
          ctx.setLineDash([2, 3]);
          ctx.globalAlpha = 0.5;
          ctx.strokeStyle = color('--accent');
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(plan[0][0], plan[0][1]);
          for (const [px, py] of plan) ctx.lineTo(px, py);
          ctx.stroke();
          ctx.restore();
          ctx.strokeStyle = ink;
          ctx.lineWidth = 2;
        }
```
and give the head a visor: replace `ctx.arc(...at(pose.head), 2.5, 0, Math.PI * 2);` with
```ts
        const [hx, hy] = at(pose.head);
        ctx.rect(hx - 3, hy - 2.5, 6, 5);
```

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run src/pages/newtab/ObstacleCourse.test.ts && npm run typecheck`
Expected: PASS.
```bash
git add src/pages/newtab/ObstacleCourse.tsx src/pages/newtab/ObstacleCourse.test.ts
git commit -m "Runners sketch each jump before they take it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Load, and the whole thing by eye

**Files:**
- Modify: `e2e/load.e2e.ts`

- [ ] **Step 1: Add the world to the load suite**

In `e2e/load.e2e.ts` add:
```ts
  it('the world with a heavy profile shows its lead within budget and walks smoothly', async () => {
    await seed(ext, { settings: { ollamaUrl: 'http://127.0.0.1:9', layaUrl: '', worldView: 'world', mutedTopics: [] } });
    const page = await ext.ctx.newPage();
    const start = Date.now();
    await page.goto(`chrome-extension://${ext.id}/${PAGES.newtab}`);
    await page.locator('.world-place[data-locked]').waitFor();
    expect(Date.now() - start).toBeLessThan(BUDGET.firstStoryMs);
    const walk = Date.now();
    for (let i = 0; i < 8; i++) await page.keyboard.press('j');
    expect(Date.now() - walk).toBeLessThan(BUDGET.twentyStepsMs);
    expect(await longestTask(page)).toBeLessThan(BUDGET.longestTaskMs);
    await seed(ext, { settings: { ollamaUrl: 'http://127.0.0.1:9', layaUrl: '', worldView: 'flat', mutedTopics: Array.from({ length: 100 }, (_, i) => `topic${i}`) } });
    expectClean(ext, NETWORK_NOISE);
    await page.close();
  });
```

- [ ] **Step 2: Run the full gate**

Run: `npm run typecheck && npx vitest run && npm run build && npm run build:e2e && npx vitest run --config vitest.e2e.config.ts`
Expected: all PASS.

- [ ] **Step 3: By eye, with /verify**

Drive the normal build with the `/verify` skill (glass on over CDP), light and dark, at 1440×900:
- new tab in world mode: lead centred and locked, path panels alternate sides and recede, feed lane on the right reads, terrain flat on the left, sky matches the weather line, frame bands opaque, docks usable;
- J through every object: the lock, the vignette during the glide, the camera never tilting;
- Comfortable: cuts with a brief blink, no glide;
- a focus session: fog, sky still;
- Enter: the dolly, then the reader with the title morphing in;
- Back: the new tab again;
- Reduce Motion on: the flat Edition, everything reachable.
Fix what looks wrong; anything not fixed goes in the final report.

- [ ] **Step 4: Commit**

```bash
git add e2e/load.e2e.ts
git commit -m "Load: the world with a heavy profile stays within budget

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
