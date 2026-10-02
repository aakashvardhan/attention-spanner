# Edition + Observatory Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-theme and re-lay-out every extension page as one system: a warm paper-and-ink "Edition" new tab, an "Observatory" reader whose chrome disappears while you read, a Clay accent, a 4px / 12-column grid, and static CI tests that keep every stylesheet on that system.

**Architecture:** All visual decisions live as tokens in `src/shared/theme.css`; pages consume tokens and place their blocks on a shared `.grid` class. A vitest suite lints every `.css` file under `src/` for token use, and a rewritten `theme.test.ts` checks token parity and contrast. New behavior (edition name, lead-story status, time left, drift nudge, section crossing) is pure functions with unit tests; components wire them up and are verified with the repo's local Playwright `/verify` pass.

**Tech Stack:** React 19, TypeScript 5.8, Vite 6 + crxjs (MV3), vitest 3 (node environment, no DOM), Playwright (local verify only), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-02-edition-observatory-redesign-design.md`

## Global Constraints

- Body font is `--font-sans` (Atkinson Hyperlegible); `font-weight` only 400/700/normal/bold.
- No pure `#fff`/`#000` text on dark surfaces; smallest text token is `--text-xs` = 12px.
- No emojis in any UI copy.
- Settings are read with `useSettings()` (`src/shared/hooks/useSettings.ts`), never `useStorageValue('settings')`.
- No new runtime dependencies. The only new persisted field is `settings.readerFocusLine: boolean` (default `false`); no schema bump.
- `prefers-reduced-motion: reduce` disables every animation and the toolbar auto-hide.
- Colors only through tokens; raw color literals are allowed only in `src/shared/theme.css`.
- Spacing px values are multiples of 4; `font-size` uses `--text-*`; `line-height` uses `--leading-*`, `1`, or `inherit`; `border-radius` uses `--radius-*`, `50%`, `0`, or `inherit`.
- Accent values: light `--accent: #b4552f` (white on it 4.91:1), `--accent-hover: #9a4528`, `--accent-text: #a8502f`; dark `--accent: #e3906e`, `--on-accent: #1a0f0a`, `--accent-text: #f0b79a`.
- Type scale (size/leading): xs 12/16, sm 14/20, md 16/24, lg 20/28, xl 24/32, 2xl 32/40, 3xl 40/48.
- Grid: `--grid-cols: 12`, `--grid-gutter: 24px`, `--grid-margin: 32px` (16px under 720px), `--grid-max: 1200px`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit only the files a task touched (`git commit -- <paths>`): the branch carries unrelated staged deletions under `functions/lib/` that must not ride along.
- **Precondition (before Task 1):** the working tree holds uncommitted phase-28 work (local AI, prune) in many of the files this plan edits (`Dashboard.tsx`, `newtab.css`, `reader.css`, `Options.tsx`, the readers…). Path-scoped commits would sweep that work into redesign commits. Ask the user to commit it first (or approve committing it as its own "phase 28" commit), and run `npm test` green on that state before starting.
- Old → new type-token remap (applied once, in Task 3): `--text-xs`→`--text-xs`, `--text-sm`→`--text-xs`, `--text-base`→`--text-sm`, `--text-md`→`--text-sm`, `--text-lg`→`--text-md`, `--text-xl`→`--text-lg`, `--text-2xl`→`--text-xl`.

## Review Focus

1. **A stored `skin` value from an old profile.** Settings objects persisted before this change still carry `skin: 'brave'`; pages must load with no error and Clay colors. Pinned by a `storage.test.ts` case in Task 2 (`getSettings` merge tolerates an unknown `skin` key) and the verify pass in Task 14 seeding `{ skin: 'alert' }`.
2. **A PDF with no outline.** No rail renders, no section toast fires, the capsule still shows page + time left. Pinned by `sectionIndexAt([], 5) === -1` and `crossedSection(-1, -1) === null` in Task 6.
3. **Time left before page text has loaded.** `pageTexts` is `null` while pdf.js extracts; the capsule must show page info without "NaN min". Pinned by `minutesLeft(null, …) === null` and `timeLeftLabel(null) === ''` in Task 6.
4. **J/K/F/Enter typed into a text field.** Typing a bookmark name or a page number must not move the story selection or toggle the focus line. Pinned by `isTypingTarget` tests in Task 5 (reused by Task 9).
5. **Coming back to a reader tab after hours away.** The drift nudge must fire once on return, not on every tick afterwards, and not again until there has been activity. Pinned by `driftStep` sequence tests in Task 6.

---

### Task 1: Design-system lint test and CI workflow

**Files:**
- Create: `src/shared/designSystem.test.ts`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `PENDING: Set<string>`, the repo-relative CSS paths not yet migrated, inside `designSystem.test.ts`. Tasks 3, 4, 5, 7, 11, 12, 13 each delete their file(s) from it; Task 14 deletes the set.
- Produces: `lintCss(source: string, file: string): Violation[]` where `interface Violation { file: string; line: number; rule: 'color' | 'spacing' | 'font-size' | 'line-height' | 'font-weight' | 'radius'; value: string }`. Exported for its own fixture tests only.

- [ ] **Step 1: Write the test file with fixtures and the sweep**

```ts
// src/shared/designSystem.test.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Every stylesheet stays on the design system in theme.css: colors through
 * tokens, spacing on the 4px grid, type and radii from their scales. Static on
 * purpose: it reads source, so it is fast and never flaky. A justified
 * exception carries `ds-exempt: <reason>` in a comment on the same line.
 */

export interface Violation {
  file: string;
  line: number;
  rule: 'color' | 'spacing' | 'font-size' | 'line-height' | 'font-weight' | 'radius';
  value: string;
}

const ROOT = join(__dirname, '..', '..');
const THEME = 'src/shared/theme.css';
const MAX_EXEMPTIONS = 12;

/** Files not yet moved onto the system. Each page task deletes its entry. */
const PENDING = new Set<string>([
  'src/shared/theme.css',
  'src/shared/components/ui.css',
  'src/shared/components/aiNote.css',
  'src/shared/components/markdown.css',
  'src/shared/components/holdToQuit.css',
  'src/pages/newtab/newtab.css',
  'src/pages/reader/reader.css',
  'src/pages/papers/papers.css',
  'src/pages/options/options.css',
  'src/pages/blocked/blocked.css',
]);

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const NAMED_COLOR = /\b(white|black|red|green|blue|orange|gray|grey|yellow|purple|pink)\b/;
const COLOR_PROPS = /^(color|background(-color)?|border(-[a-z]+)*|outline(-color)?|fill|stroke|box-shadow|text-decoration-color|caret-color|accent-color)$/;
const SPACING_PROPS = /^((margin|padding|inset)(-[a-z-]+)?|gap|row-gap|column-gap|top|right|bottom|left|grid-template-(columns|rows))$/;
const PX = /(-?\d*\.?\d+)px/g;

/** Blank out comments but keep every newline, so line numbers survive. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

export function lintCss(source: string, file: string): Violation[] {
  const exempt = new Set(
    source.split('\n').flatMap((l, i) => (l.includes('ds-exempt:') ? [i + 1] : [])),
  );
  const lines = stripComments(source).split('\n');
  const out: Violation[] = [];
  const isTheme = file === THEME;
  lines.forEach((text, i) => {
    const line = i + 1;
    if (exempt.has(line)) return;
    const m = /^\s*([a-z-]+)\s*:\s*([^;{}]+)/.exec(text);
    // Continuation lines of a multi-line value (box-shadow stacks) still carry colors.
    if (!m) {
      if (!isTheme && COLOR_LITERAL.test(text)) out.push({ file, line, rule: 'color', value: text.trim() });
      return;
    }
    const [, prop, rawValue] = m;
    const value = rawValue.trim();
    if (prop.startsWith('--')) {
      if (!isTheme && COLOR_LITERAL.test(value)) out.push({ file, line, rule: 'color', value });
      return;
    }
    if (!isTheme && (COLOR_LITERAL.test(value) || (COLOR_PROPS.test(prop) && NAMED_COLOR.test(value)))) {
      out.push({ file, line, rule: 'color', value });
    }
    if (SPACING_PROPS.test(prop)) {
      for (const [, n] of value.matchAll(PX)) {
        if (Number(n) % 4 !== 0) out.push({ file, line, rule: 'spacing', value });
      }
    }
    if (prop === 'font-size' && !/^(var\(--text-[a-z0-9]+\)|inherit)$/.test(value)) {
      out.push({ file, line, rule: 'font-size', value });
    }
    if (prop === 'line-height' && !/^(var\(--leading-[a-z0-9]+\)|1|inherit)$/.test(value)) {
      out.push({ file, line, rule: 'line-height', value });
    }
    if (prop === 'font-weight' && !/^(400|700|normal|bold|inherit)$/.test(value)) {
      out.push({ file, line, rule: 'font-weight', value });
    }
    if (prop === 'border-radius' && !/^((var\(--radius-[a-z0-9]+\)|50%|0|inherit)\s*)+$/.test(value)) {
      out.push({ file, line, rule: 'radius', value });
    }
  });
  return out;
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith('.css') ? [relative(ROOT, path)] : [];
  });
}

describe('lintCss', () => {
  const lint = (css: string) => lintCss(css, 'x.css').map((v) => v.rule);

  it('rejects color literals outside theme.css, including multi-line shadows', () => {
    expect(lint('a { color: #fff; }')).toEqual(['color']);
    expect(lint('a {\n  box-shadow: 0 0 0 1px var(--border),\n    0 4px 8px rgba(0,0,0,.2);\n}')).toEqual(['color']);
    expect(lint('a { border-color: white; }')).toEqual(['color']);
    expect(lintCss('a { color: #fff; }', 'src/shared/theme.css')).toEqual([]);
  });

  it('accepts tokens, currentColor and transparent', () => {
    expect(lint('a { color: var(--text-primary); background: transparent; fill: currentColor; }')).toEqual([]);
  });

  it('holds spacing to multiples of 4px, including inside calc and grid templates', () => {
    expect(lint('a { padding: 6px 8px; }')).toEqual(['spacing']);
    expect(lint('a { margin: calc(100% - 10px); }')).toEqual(['spacing']);
    expect(lint('a { grid-template-columns: 1fr 70px; }')).toEqual(['spacing']);
    expect(lint('a { padding: var(--space-2) 12px; gap: 0; top: 50%; }')).toEqual([]);
  });

  it('holds type to the scale', () => {
    expect(lint('a { font-size: 13px; }')).toEqual(['font-size']);
    expect(lint('a { line-height: 1.5; }')).toEqual(['line-height']);
    expect(lint('a { font-weight: 600; }')).toEqual(['font-weight']);
    expect(lint('a { font-size: var(--text-sm); line-height: var(--leading-sm); font-weight: 700; }')).toEqual([]);
  });

  it('holds radii to tokens', () => {
    expect(lint('a { border-radius: 6px; }')).toEqual(['radius']);
    expect(lint('a { border-radius: var(--radius-lg) var(--radius-lg) 0 0; }')).toEqual([]);
  });

  it('skips a line that carries ds-exempt', () => {
    expect(lint('a { color: #fff; } /* ds-exempt: brand mark */')).toEqual([]);
  });

  it('ignores comments', () => {
    expect(lint('/* color: #fff; padding: 3px */')).toEqual([]);
  });
});

describe('every stylesheet', () => {
  const files = cssFiles(join(ROOT, 'src'));

  it('lists only real files as pending', () => {
    for (const file of PENDING) expect(files).toContain(file);
  });

  it.each(files.filter((f) => !PENDING.has(f)))('%s stays on the design system', (file) => {
    const violations = lintCss(readFileSync(join(ROOT, file), 'utf8'), file);
    expect(violations.map((v) => `${v.file}:${v.line} ${v.rule} ${v.value}`)).toEqual([]);
  });

  it('keeps exemptions rare', () => {
    const count = files
      .map((f) => readFileSync(join(ROOT, f), 'utf8').split('ds-exempt:').length - 1)
      .reduce((a, b) => a + b, 0);
    expect(count).toBeLessThanOrEqual(MAX_EXEMPTIONS);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/shared/designSystem.test.ts`
Expected: PASS. All fixture tests pass; every CSS file is still pending, so the sweep's `it.each` generates no cases until Task 3 removes the first file from `PENDING`.

- [ ] **Step 3: Write the CI workflow**

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

- [ ] **Step 4: Run the same steps locally**

Run: `npm run typecheck && npm test && npm run build > /tmp/build.log 2>&1; echo $?; tail -5 /tmp/build.log`
Expected: exit 0; all tests pass. (Never pipe the build to `/dev/null`: a hidden tsc failure leaves a stale `dist/`.)

- [ ] **Step 5: Commit**

```bash
git add src/shared/designSystem.test.ts .github/workflows/ci.yml
git commit -m "Lint every stylesheet against the design system, and run checks in CI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/shared/designSystem.test.ts .github/workflows/ci.yml
```

---

### Task 2: Retire the skins

**Files:**
- Modify: `src/shared/types.ts` (delete `SkinSetting` and `Settings.skin`)
- Modify: `src/shared/storage.ts:62-83` (drop `skin` default), `:182-186` (v15 comment), `:216` (v15 call), `:409-418` (`v15Skin`, `migrateToV15`)
- Modify: `src/shared/storage.test.ts:110-130` (drop `v15Skin` tests, add old-profile merge test)
- Modify: `src/shared/theme.ts` (delete skin code)
- Modify: `src/shared/theme.test.ts` (delete `resolveSkin` tests)
- Modify: `src/shared/hooks/useTheme.ts` (delete skin effect)
- Modify: `src/pages/options/Options.tsx:9,147-164` (delete Accent row and hint)
- Modify: `src/pages/newtab/Dashboard.tsx:38` (comment: "a skin or theme" → "a theme")
- Delete: `src/shared/capabilities.ts`, `src/shared/capabilities.test.ts` (their only consumer was `resolveSkin`)
- Modify: `src/shared/theme.css` (delete everything from the `Skins.` banner comment through the last `[data-skin=…]` block)

**Interfaces:**
- Produces: `initTheme(): void` and `applyTheme(mode: ThemeSetting): ResolvedTheme` keep their signatures; `applySkin`, `resolveSkin`, `ResolvedSkin`, `SkinSetting`, `detectCapabilities` no longer exist.

- [ ] **Step 1: Write the failing old-profile test in `src/shared/storage.test.ts`**

Replace the whole `describe('v15Skin', …)` block and its comment with:

```ts
/*
 * The skin setting is gone, but patchSettings persisted whole settings
 * objects for months, so real profiles still carry `skin`. It must be inert.
 */
describe('a stored settings object from before the skins were retired', () => {
  it('merges over the defaults without resurrecting skin as a known field', () => {
    const merged = { ...DEFAULT_SETTINGS, ...({ skin: 'alert', focusMinutes: 25 } as Partial<Settings>) };
    expect(merged.focusMinutes).toBe(25);
    expect('skin' in DEFAULT_SETTINGS).toBe(false);
  });
});
```

Make sure `DEFAULT_SETTINGS` and the `Settings` type are imported at the top of the test (add to the existing imports from `./storage` and `./types`), and remove `v15Skin` from the import list.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/shared/storage.test.ts`
Expected: FAIL. `'skin' in DEFAULT_SETTINGS` is `true`.

- [ ] **Step 3: Delete the skin code**

In `src/shared/types.ts`, delete the `SkinSetting` doc comment and type, and the `skin` field with its comment from `Settings`.

In `src/shared/storage.ts`: delete the `skin: 'brave'` line and its comment from `DEFAULT_SETTINGS`; delete `export function v15Skin` and `async function migrateToV15`; change line 216 from `if (version < 15) await migrateToV15();` to nothing (delete the line); in the migration history comment, replace the v14 → v15 paragraph with:

```
 * v14 → v15 rewrote a stored skin 'auto' to 'brave'. Skins were retired in the
 * Edition redesign (2026-10), so the step is gone; the version number stays.
```

`src/shared/theme.ts` becomes:

```ts
import type { ThemeSetting } from './types';

export type ResolvedTheme = 'light' | 'dark';

/**
 * localStorage mirror of settings.theme. chrome.storage is async, so first
 * paint would flash light without a synchronously readable copy; all extension
 * pages share one chrome-extension:// origin, so one mirror serves them all.
 */
const MIRROR_KEY = 'themeMode';

export function resolveTheme(mode: ThemeSetting, prefersDark: boolean): ResolvedTheme {
  return mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
}

export function applyTheme(mode: ThemeSetting): ResolvedTheme {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = resolveTheme(mode, prefersDark);
  document.documentElement.dataset.theme = resolved;
  localStorage.setItem(MIRROR_KEY, mode);
  return resolved;
}

/** Call at module top of each page's main.tsx, before React mounts (MV3 CSP forbids inline scripts) */
export function initTheme(): void {
  const stored = localStorage.getItem(MIRROR_KEY);
  applyTheme(stored === 'light' || stored === 'dark' ? stored : 'system');
}
```

In `src/shared/theme.test.ts`, delete the `describe('resolveSkin', …)` block and change the import to `import { resolveTheme } from './theme';`.

In `src/shared/hooks/useTheme.ts`: import only `applyTheme, type ResolvedTheme` from `../theme`; delete `const skin = settings.skin;` and the second `useEffect` with its comment.

In `src/pages/options/Options.tsx`: change the type import to `import type { ThemeSetting } from '../../shared/types';`; delete the `<div className="setting-row">` that holds `skin-select` and the `<p className="hint">` under it.

Delete `src/shared/capabilities.ts` and `src/shared/capabilities.test.ts`.

In `src/shared/theme.css`, delete from the comment that begins `Skins. <html data-skin=` through the end of the last `:root[data-skin='alert'][data-theme='dark'] { … }` block, and change the focus-ring comment "in the current skin's accent" to "in the accent".

- [ ] **Step 4: Prove nothing still references skins, then run everything**

Run: `grep -rn "skin\|Skin\|capabilities\|isBrave" src; npm run typecheck && npx vitest run`
Expected: grep prints nothing; typecheck clean; all tests pass.

- [ ] **Step 5: Commit**

```bash
git rm -q src/shared/capabilities.ts src/shared/capabilities.test.ts
git commit -m "Retire the accent skins: Clay is the design, not an option

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/shared/types.ts src/shared/storage.ts src/shared/storage.test.ts src/shared/theme.ts src/shared/theme.test.ts src/shared/hooks/useTheme.ts src/pages/options/Options.tsx src/pages/newtab/Dashboard.tsx src/shared/capabilities.ts src/shared/capabilities.test.ts src/shared/theme.css
```

---

### Task 3: Paper, ink and Clay tokens, the type scale, and the grid

**Files:**
- Modify: `src/shared/theme.css` (`:root` and `:root[data-theme='dark']` blocks, plus a new `.grid` rule)
- Modify: every `.css` file under `src/` (mechanical `--text-*` remap only)
- Modify: `src/shared/theme.test.ts` (token tests)
- Modify: `src/shared/designSystem.test.ts` (remove `'src/shared/theme.css'` from `PENDING`)

**Interfaces:**
- Produces tokens used by every later task: `--font-display`; `--text-xs|sm|md|lg|xl|2xl|3xl` and matching `--leading-*`; `--space-1..8`; `--radius-sm|md|lg|xl|2xl|pill`; `--grid-cols|gutter|margin|max`; `--rule` (the double-rule ink color); `--reading-dim` (focus-line dimming); `.grid` class.

- [ ] **Step 1: Write the failing token tests**

Append to `src/shared/theme.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, 'theme.css'), 'utf8');

/** `--name: value` pairs declared directly inside the block that opens with `selector {`. */
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing block ${selector}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf('\n}', start));
  return new Map([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const light = block(':root');
const dark = block(":root[data-theme='dark']");

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('theme tokens', () => {
  it('dark overrides every themed color the light block declares', () => {
    const themed = [...light].filter(([k, v]) => !k.startsWith('--focus-') && /#|rgba?\(/.test(v)).map(([k]) => k);
    const missing = themed.filter((k) => !dark.has(k));
    expect(missing).toEqual([]);
    const extra = [...dark.keys()].filter((k) => !light.has(k));
    expect(extra).toEqual([]);
  });

  it('puts spacing, radii and leading on the 4px grid', () => {
    for (const [k, v] of light) {
      if (!/^--(space|radius|leading|grid-gutter|grid-margin)/.test(k) || k === '--radius-pill') continue;
      expect(parseFloat(v) % 4, `${k}: ${v}`).toBe(0);
    }
  });

  it('pairs every text size with a leading', () => {
    // Size tokens only: --text-primary and friends are colors, not sizes.
    const sizes = [...light].filter(([k, v]) => k.startsWith('--text-') && v.endsWith('px')).map(([k]) => k.slice(7));
    expect(sizes).toEqual(['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl']);
    for (const s of sizes) expect(light.has(`--leading-${s}`), s).toBe(true);
  });

  it.each([
    ['light', light],
    ['dark', dark],
  ] as const)('%s text clears contrast floors', (_, t) => {
    const get = (k: string) => (t.get(k) ?? light.get(k))!;
    const body: [string, string][] = [
      ['--text-primary', '--bg-page'],
      ['--text-primary', '--bg-surface'],
      ['--text-secondary', '--bg-page'],
      ['--text-secondary', '--bg-surface'],
      ['--text-muted', '--bg-page'],
      ['--text-muted', '--bg-surface'],
      ['--text-muted', '--bg-subtle'],
      ['--on-accent', '--accent'],
      ['--accent-text', '--bg-surface'],
    ];
    for (const [fg, bg] of body) expect(contrast(get(fg), get(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(get('--accent'), get('--bg-page')), 'accent on page').toBeGreaterThanOrEqual(3);
  });

  it('carries no skin blocks', () => {
    expect(css).not.toContain('data-skin');
  });
});
```

(Keep the existing `resolveTheme` describe; merge the `vitest` import line so `describe, expect, it` is imported once.)

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/shared/theme.test.ts`
Expected: FAIL. Type sizes are `xs, sm, base, md, lg, xl, 2xl` with no `--leading-*`, the light accent `#0ea5e9` fails 4.5:1 with white, and the radii are not all multiples of 4.

- [ ] **Step 3: Remap type tokens across every stylesheet (before changing their values)**

Save as `scripts/remap-type-tokens.mjs`, run once, then delete it (it is not committed):

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const map = { xs: 'xs', sm: 'xs', base: 'sm', md: 'sm', lg: 'md', xl: 'lg', '2xl': 'xl' };
const files = execSync("find src -name '*.css' ! -name theme.css").toString().trim().split('\n');
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  // One pass with a callback, so a remapped value is never remapped again.
  const out = src.replace(/var\(--text-(xs|sm|base|md|lg|xl|2xl)\)/g, (_, k) => `var(--text-${map[k]})`);
  if (out !== src) writeFileSync(f, out);
}
```

Run: `node scripts/remap-type-tokens.mjs && rm scripts/remap-type-tokens.mjs && grep -rn "text-base" src --include='*.css'`
Expected: grep prints nothing.

- [ ] **Step 4: Rewrite the token blocks in `src/shared/theme.css`**

In `:root`, replace the scale section (from `--space-1` through `--ease-spring`) and the color section (from `--bg-page` through `--heat-cell-border`) with these values. Keep every existing comment that still describes a kept token; delete comments about YouTube-neutral greys and the sky accent.

```css
  --font-display: ui-serif, 'New York', 'Iowan Old Style', Georgia, serif;

  /* The grid coordinate system. Everything snaps to a 4px unit; page layouts
     place blocks on a 12-column grid (.grid below). designSystem.test.ts holds
     every stylesheet to these. */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;
  --space-8: 64px;

  --grid-cols: 12;
  --grid-gutter: 24px;
  --grid-margin: 32px;
  --grid-max: 1200px;

  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-2xl: 24px;
  --radius-pill: 999px;

  /* Type scale, each size paired with a leading on the 4px baseline. */
  --text-xs: 12px;
  --leading-xs: 16px;
  --text-sm: 14px;
  --leading-sm: 20px;
  --text-md: 16px;
  --leading-md: 24px;
  --text-lg: 20px;
  --leading-lg: 28px;
  --text-xl: 24px;
  --leading-xl: 32px;
  --text-2xl: 32px;
  --leading-2xl: 40px;
  --text-3xl: 40px;
  --leading-3xl: 48px;

  --transition-fast: 0.15s;
  --transition-base: 0.2s;
  --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
  --ease-spring: cubic-bezier(0.34, 1.2, 0.64, 1);

  /* Paper and ink. */
  --bg-page: #f5f0e6;
  --bg-surface: #fbf8f2;
  --bg-subtle: #ece5d7;
  --bg-hover: #e4dccd;

  --text-primary: #2b2520;
  --text-secondary: #5a5048;
  --text-muted: #6b6158;
  /* Decorative only (rules, glyphs) — never carries words. */
  --text-faint: #8a7f74;

  --rule: #2b2520;
  --border: #d9cfbf;
  --border-subtle: #e4dccd;
  --disabled: #c9bfb0;

  /* Clay. #b4552f rather than the brighter #c96442 so white labels on it clear 4.5:1. */
  --accent: #b4552f;
  --accent-hover: #9a4528;
  --accent-soft: #f7ece4;
  --accent-wash: #f1ddd0;
  --accent-border: #e2b9a3;
  --accent-track: #ecd2c3;
  --accent-text: #a8502f;
  --on-accent: #ffffff;

  --success: #2e7d32;
  --success-bg: #e8f1e4;
  --success-border: #c5dcbf;
  --danger: #b3261e;
  --danger-bg: #f9e3df;
  --warning: #8a5300;
  --warning-bg: #f6ead2;

  /* Focus line: what everything outside the current passage is washed with. */
  --reading-dim: rgba(245, 240, 230, 0.72);

  --shadow-sm: 0 1px 4px rgba(60, 40, 20, 0.08);
  --shadow-lg: 0 8px 24px rgba(60, 40, 20, 0.16);
  --shadow-accent: 0 2px 10px rgba(180, 85, 47, 0.18);
```

Keep the `--shadow-card`, `--shadow-card-hover`, `--glass-*` and `--material-*` token names, retinting the light values to the paper family: `--glass-surface: rgba(251, 248, 242, 0.92)`, `--glass-bar: rgba(251, 248, 242, 0.6)`, `--material-thin: rgba(251, 248, 242, 0.6)`, `--material-regular: rgba(251, 248, 242, 0.92)`, `--material-thick: rgba(251, 248, 242, 0.97)`, `--glass-accent: rgba(241, 221, 208, 0.72)`, `--glass-tint: rgba(180, 85, 47, 0.08)`, `--glass-tint-2: rgba(201, 100, 66, 0.06)`, and the ring shadows from `rgba(0, 0, 0, …)` to `rgba(60, 40, 20, …)` at the same alphas. Heat ramp: `--heat-0: #ece5d7; --heat-1: #f1ddd0; --heat-2: #e2b9a3; --heat-3: #c96442; --heat-4: #9a4528;`.

In `:root[data-theme='dark']`, set:

```css
  --bg-page: #0e0c0b;
  --bg-surface: #191512;
  --bg-subtle: #221d1a;
  --bg-hover: #2c2622;

  --text-primary: #ece4d8;
  --text-secondary: #c4b8aa;
  --text-muted: #a89c8f;
  --text-faint: #7d7268;

  --rule: #ece4d8;
  --border: #3a332d;
  --border-subtle: #2c2622;
  --disabled: #4a423b;

  --accent: #e3906e;
  --accent-hover: #f0b79a;
  --accent-soft: #241912;
  --accent-wash: #2e2018;
  --accent-border: #5a3a2a;
  --accent-track: #3d2a1f;
  --accent-text: #f0b79a;
  /* 7.59:1 — a light clay cannot carry white labels */
  --on-accent: #1a0f0a;

  --success: #8fc79a;
  --success-bg: #18241b;
  --success-border: #2f4a35;
  --danger: #f2a39b;
  --danger-bg: #2e1a17;
  --warning: #e8c27a;
  --warning-bg: #2b2416;

  --reading-dim: rgba(14, 12, 11, 0.72);

  --shadow-sm: 0 1px 4px rgba(0, 0, 0, 0.5);
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.6);
  --shadow-accent: 0 0 12px rgba(227, 144, 110, 0.35);
```

Glass and material in dark use the warm surface: `--glass-surface: rgba(25, 21, 18, 0.9)`, `--glass-bar: rgba(236, 228, 216, 0.05)`, `--material-thin: rgba(20, 17, 15, 0.6)`, `--material-regular: rgba(25, 21, 18, 0.9)`, `--material-thick: rgba(20, 17, 15, 0.97)`, `--glass-accent: rgba(227, 144, 110, 0.14)`, `--glass-tint: rgba(227, 144, 110, 0.08)`, `--glass-tint-2: rgba(201, 100, 66, 0.06)`. Heat: `--heat-0: #221d1a; --heat-1: #3d2a1f; --heat-2: #7a4630; --heat-3: #c96442; --heat-4: #f0b79a;`. Keep `--glass-rim`/`--glass-rim-strong`/`--shadow-card*` as they are in dark.

After the `:focus-visible` rule, add:

```css
/* The page grid. Every page's top-level layout is a .grid and places its
   blocks with grid-column spans, so all pages share one set of column lines. */
.grid {
  display: grid;
  grid-template-columns: repeat(var(--grid-cols), minmax(0, 1fr));
  column-gap: var(--grid-gutter);
  max-width: var(--grid-max);
  margin-inline: auto;
  padding-inline: var(--grid-margin);
  box-sizing: border-box;
  width: 100%;
}
@media (max-width: 720px) {
  :root {
    --grid-margin: 16px;
  }
}
```

Move `src/shared/theme.css`'s own `font-weight`/`line-height`/`border-radius` declarations (if any rule outside the token blocks uses raw values) onto tokens so it lints clean, then delete `'src/shared/theme.css'` from `PENDING` in `designSystem.test.ts`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/shared/theme.test.ts src/shared/designSystem.test.ts`
Expected: PASS. If a contrast assertion fails, adjust only that token's value (darker in light, lighter in dark) and rerun.

- [ ] **Step 6: Build and look**

Run: `npm run build > /tmp/build.log 2>&1; echo $?` then the screenshot script from `.claude/skills/verify/SKILL.md` on the new tab and reader.
Expected: exit 0; pages render in paper/ink (light) and warm ink (dark) with the existing layouts, and nothing is unreadable.

- [ ] **Step 7: Commit**

```bash
git commit -m "Paper, ink and Clay tokens on a 4px / 12-column grid

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/shared/theme.css src/shared/theme.test.ts src/shared/designSystem.test.ts $(git diff --name-only -- 'src/**/*.css')
```

---

### Task 4: Shared component stylesheets on the system

**Files:**
- Modify: `src/shared/components/ui.css`, `aiNote.css`, `markdown.css`, `holdToQuit.css`
- Modify: `src/shared/designSystem.test.ts` (remove those four from `PENDING`)

**Interfaces:**
- Consumes: Task 3 tokens.
- Produces: shared primitives restyled: `.fc-primary-btn` is ink-filled (`background: var(--rule); color: var(--bg-page)`), `.ghost-btn` is text-only. Later page tasks rely on these two class names.

- [ ] **Step 1: Remove the four files from `PENDING` and run the sweep**

Run: `npx vitest run src/shared/designSystem.test.ts`
Expected: FAIL, listing each `file:line rule value` to fix.

- [ ] **Step 2: Fix every listed violation**

Rules for each violation kind:
- `color`: replace with the nearest token (`--text-*`, `--bg-*`, `--border*`, `--accent*`, `--on-accent`, `--danger*`). For `holdToQuit.css`'s fill, use `var(--on-accent)` at its current alpha via a token: add `--hold-fill: rgba(255, 255, 255, 0.25);` to both theme blocks in `theme.css` only if no existing token fits.
- `spacing`: round to the nearest multiple of 4, preferring a `--space-*` token (e.g. `6px` → `var(--space-2)`, `10px` → `var(--space-3)`, `2px` → `var(--space-1)` or `0`).
- `font-size`: map to the scale (`11px`/`12px` → `--text-xs`, `13px`/`14px`/`0.9em` → `--text-sm`, `16px` → `--text-md`).
- `line-height`: unitless body values (`1.4`–`1.6`) become the `--leading-*` that matches the element's font-size token; icon/control rows use `1`.
- `radius`: `6px` → `var(--radius-sm)`, `10px` → `var(--radius-md)`, `14px` → `var(--radius-lg)`, `20px`/`22px` → `var(--radius-2xl)`.

Then make the two shared buttons match the Edition:

```css
.fc-primary-btn {
  background: var(--rule);
  color: var(--bg-page);
  border: 0;
  border-radius: var(--radius-pill);
  padding: var(--space-2) var(--space-4);
  font-size: var(--text-sm);
  line-height: var(--leading-sm);
  font-weight: 700;
}
.fc-primary-btn:hover:not(:disabled) {
  background: var(--accent);
  color: var(--on-accent);
}
.fc-primary-btn:disabled {
  background: var(--bg-subtle);
  color: var(--text-muted);
}
```

(Edit the existing `.fc-primary-btn` rules in whichever shared file defines them: `grep -rn "fc-primary-btn" src --include='*.css'`.)

- [ ] **Step 3: Run the sweep again**

Run: `npx vitest run src/shared/designSystem.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git commit -m "Move the shared component styles onto the token grid

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/shared/components/ui.css src/shared/components/aiNote.css src/shared/components/markdown.css src/shared/components/holdToQuit.css src/shared/designSystem.test.ts src/shared/theme.css
```

---

### Task 5: The Edition new tab

**Files:**
- Modify: `src/pages/newtab/Hero.tsx` (masthead; add `editionName`)
- Modify: `src/pages/newtab/Hero.test.ts`
- Modify: `src/pages/newtab/ContinueRow.tsx` (add `lead` variant and `leadStatus`, `kickerFor`)
- Create: `src/pages/newtab/ContinueRow.test.ts`
- Create: `src/shared/keys.ts`, `src/shared/keys.test.ts` (`isTypingTarget`)
- Modify: `src/pages/newtab/Dashboard.tsx` (grid layout, lead story, sidebar, index row, J/K/Enter)
- Modify: `src/pages/newtab/TriageCard.tsx` (headline-story markup; no logic change)
- Modify: `src/pages/newtab/BookmarksPanel.tsx` (index-row markup; no logic change)
- Modify: `src/pages/newtab/NowWatching.tsx` (add "Live" kicker)
- Modify: `src/pages/newtab/newtab.css` (rewrite)
- Modify: `src/shared/designSystem.test.ts` (remove `newtab.css` from `PENDING`)

**Interfaces:**
- Consumes: `greetingFor(hour)` (Hero.tsx), `resumableItems`, `ResumableItem` (`src/shared/attention.ts`), `unreadItems(items, readIds, cap)` (`src/shared/llm/triage.ts`), `formatRelativeDate`, `formatWatchTime` (`src/shared/format.ts`).
- Produces: `editionName(hour: number): string`; `leadStatus(item: ResumableItem): string`; `kickerFor(item: ResumableItem): string`; `isTypingTarget(target: EventTarget | null): boolean` (Task 9 reuses it); `Hero({ status }: { status: string })`; `ContinueRow` gains optional props `lead?: boolean` and `selected?: boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `src/pages/newtab/Hero.test.ts` (and add `editionName` to its import from `./Hero`):

```ts
describe('editionName', () => {
  it('follows the same hour boundaries as the greeting', () => {
    expect(editionName(0)).toBe('The Late Edition');
    expect(editionName(4)).toBe('The Late Edition');
    expect(editionName(5)).toBe('The Morning Edition');
    expect(editionName(11)).toBe('The Morning Edition');
    expect(editionName(12)).toBe('The Afternoon Edition');
    expect(editionName(17)).toBe('The Afternoon Edition');
    expect(editionName(18)).toBe('The Evening Edition');
    expect(editionName(23)).toBe('The Evening Edition');
  });
});
```

Create `src/pages/newtab/ContinueRow.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ResumableItem } from '../../shared/attention';
import type { Paper, ReadingProgress, VideoProgress } from '../../shared/types';
import { kickerFor, leadStatus } from './ContinueRow';

const base = { maxPercent: 42, activeSeconds: 0, firstOpenedAt: 0, completedAt: null, nudge: { count: 0, lastAt: 0, dismissed: false } };
const article = (updatedAt: number): ResumableItem => ({
  key: 'a', title: 'A', updatedAt, paper: null,
  progress: { ...base, url: 'https://x.org/a', title: 'A', source: 'Distill', updatedAt, kind: 'article', feedItemId: null, scrollY: 0, pageHeight: 1 } as ReadingProgress,
});
const video: ResumableItem = {
  key: 'v', title: 'V', updatedAt: 0, paper: null,
  progress: { ...base, url: 'https://youtube.com/watch?v=1', title: 'V', source: 'Ch', updatedAt: 0, kind: 'video', videoId: '1', durationSeconds: 600, positionSeconds: 125 } as VideoProgress,
};
const paper = (extra: Partial<Paper>): ResumableItem => ({
  key: 'p', title: 'P', updatedAt: 0, progress: null,
  paper: { progressPercent: 30, leftOff: '', ...extra } as Paper,
});

describe('leadStatus', () => {
  it('gives a paper opened in the reader its page, and the left-off note when there is one', () => {
    expect(leadStatus(paper({ pdf: { url: 'u', page: 4, pageCount: 15, offset: 0 } }))).toBe('Page 4 of 15');
    expect(leadStatus(paper({ pdf: { url: 'u', page: 4, pageCount: 15, offset: 0 }, leftOff: 'Section 4.2' }))).toBe('Page 4 of 15 · Section 4.2');
  });

  it('falls back to percent for a paper never opened in the reader', () => {
    expect(leadStatus(paper({}))).toBe('30% read');
  });

  it('gives an article its percent and when it was opened', () => {
    expect(leadStatus(article(Date.now() - 2 * 3_600_000))).toBe('42% read · opened 2h ago');
  });

  it('gives a video its position and length', () => {
    expect(leadStatus(video)).toBe('2:05 of 10:00');
  });
});

describe('kickerFor', () => {
  it('names what kind of thing is waiting', () => {
    expect(kickerFor(paper({}))).toBe('Continue reading · paper');
    expect(kickerFor(article(0))).toBe('Continue reading · article');
    expect(kickerFor(video)).toBe('Continue watching · video');
  });
});
```

Create `src/shared/keys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isTypingTarget } from './keys';

const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, isContentEditable: false, ...extra }) as unknown as EventTarget;

describe('isTypingTarget', () => {
  it('is true for fields that take text', () => {
    expect(isTypingTarget(el('INPUT'))).toBe(true);
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true);
    expect(isTypingTarget(el('SELECT'))).toBe(true);
    expect(isTypingTarget(el('DIV', { isContentEditable: true }))).toBe(true);
  });

  it('is false for everything else', () => {
    expect(isTypingTarget(el('BUTTON'))).toBe(false);
    expect(isTypingTarget(el('BODY'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/pages/newtab src/shared/keys.test.ts`
Expected: FAIL. `editionName`, `leadStatus`, `kickerFor` and `./keys` do not exist.

- [ ] **Step 3: Implement the pure functions**

`src/shared/keys.ts`:

```ts
/** Single-key shortcuts must not fire while someone is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el?.tagName) return false;
  return el.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}
```

In `Hero.tsx`, next to `greetingFor`:

```ts
/** The masthead. Same boundaries as greetingFor, so the two never disagree. */
export function editionName(hour: number): string {
  if (hour < 5) return 'The Late Edition';
  if (hour < 12) return 'The Morning Edition';
  if (hour < 18) return 'The Afternoon Edition';
  return 'The Evening Edition';
}
```

In `ContinueRow.tsx` (add `formatRelativeDate` to the `format` import):

```ts
/** The lead story's status line: where you are, in the unit the thing has. */
export function leadStatus(item: ResumableItem): string {
  const { paper, progress } = item;
  if (paper) {
    if (!paper.pdf) return `${Math.round(paper.progressPercent)}% read`;
    const page = `Page ${paper.pdf.page} of ${paper.pdf.pageCount}`;
    return paper.leftOff ? `${page} · ${paper.leftOff}` : page;
  }
  if (progress?.kind === 'video') {
    return `${formatWatchTime(progress.positionSeconds)} of ${formatWatchTime(progress.durationSeconds)}`;
  }
  const opened = formatRelativeDate(new Date(item.updatedAt)).replace(/^Just now$/, 'just now');
  return `${Math.round(progress?.maxPercent ?? 0)}% read · opened ${opened}`;
}

export function kickerFor(item: ResumableItem): string {
  if (item.paper) return 'Continue reading · paper';
  return item.progress?.kind === 'video' ? 'Continue watching · video' : 'Continue reading · article';
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/pages/newtab src/shared/keys.test.ts`
Expected: PASS.

- [ ] **Step 5: Masthead markup (`Hero.tsx`)**

Replace the `Hero` component:

```tsx
export function Hero({ status }: { status: string }) {
  const [settings] = useSettings();
  const now = new Date();
  const hour = now.getHours();
  const greeting = `${greetingFor(hour)}${settings.displayName ? `, ${settings.displayName}` : ''}`;

  return (
    <header className="edition-masthead">
      <p className="edition-dateline">
        {now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
      </p>
      <h1 className="edition-name">{editionName(hour)}</h1>
      <div className="edition-weatherline">
        <Clock />
        <Weather location={settings.weatherLocation} />
      </div>
      <p className="edition-dek">
        <span>{greeting.endsWith('?') ? greeting : `${greeting}.`}</span>
        <span>{status}</span>
      </p>
    </header>
  );
}
```

`Clock` keeps its minute-aligned timer but renders `<time className="edition-clock" dateTime={…}>{formatTime(now)}</time>` (no wrapping `<p>`). Remove the `quoteOfDay`/`localDate` imports from Hero (the quote moves to the sidebar in Step 7).

- [ ] **Step 6: Lead variant in `ContinueRow.tsx`**

Add props `lead = false` and `selected = false` to the signature. Inside the main `<button>`, render the lead layout when `lead` is true and the existing row otherwise:

```tsx
{lead ? (
  <span className="edition-lead-text">
    <span className="edition-kicker">{kickerFor(item)}</span>
    <span className="edition-headline">{item.title}</span>
    <span className="edition-lead-status">{leadStatus(item)}</span>
    <span className="relay-row-meter" aria-hidden="true">
      <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </span>
    <span className="edition-cta">
      Pick it back up <kbd>Enter</kbd>
    </span>
  </span>
) : (
  /* the existing relay-row-text span, unchanged */
)}
```

Set `className={lead ? 'edition-lead' : 'relay-row'}` and `aria-current={selected || undefined}` on that button, and add `data-story` to it so the Dashboard keyboard handler can find every story (`[data-story]`).

- [ ] **Step 7: Dashboard layout and keys (`Dashboard.tsx`)**

Add imports: `unreadItems` from `../../shared/llm/triage`, `isTypingTarget` from `../../shared/keys`, `localDate` from `../../shared/format`, `quoteOfDay` from `./quotes`. Read `const [cachedItems] = useStorageValue('cachedItems'); const [readItems] = useStorageValue('readItems');`.

Compute the dek status:

```ts
const unreadCount = unreadItems(cachedItems, readItems, cachedItems.length).length;
const status = [
  resumable.length ? `${resumable.length} unfinished` : null,
  unreadCount ? `${unreadCount} new in your feeds` : null,
].filter(Boolean).join(' · ');
```

Keyboard selection across every `[data-story]` button (lead, also-unfinished rows, triage stories):

```ts
const [selected, setSelected] = useState(0);
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
    const stories = [...document.querySelectorAll<HTMLElement>('[data-story]')];
    if (stories.length === 0) return;
    if (e.key === 'j' || e.key === 'k') {
      e.preventDefault();
      setSelected((i) => {
        const next = Math.min(stories.length - 1, Math.max(0, i + (e.key === 'j' ? 1 : -1)));
        stories[next].focus();
        return next;
      });
    } else if (e.key === 'Enter' && document.activeElement === document.body) {
      e.preventDefault();
      stories[selected]?.click();
    }
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}, [selected]);
```

(Enter on a focused button already clicks it natively; the handler covers Enter with nothing focused, which opens the lead because `selected` starts at 0.)

Render:

```tsx
<main className="edition grid">
  <Hero status={status} />

  {watching.active && <NowWatching watching={watching} />}

  <section className="edition-lead-col" aria-labelledby="continue-title">
    <h2 id="continue-title" className="visually-hidden">Continue reading</h2>
    {resumable.length === 0 ? (
      <p className="edition-notice">
        Nothing open. Press ⌘/Ctrl+Shift+E on any page to read it here.
      </p>
    ) : (
      <>
        <ul className="edition-lead-list">
          <ContinueRow lead selected={selected === 0} item={resumable[0]} now={watchingNow} onOpen={(alt) => open(resumable[0], alt)} />
        </ul>
        {resumable.length > 1 && (
          <>
            <p className="edition-kicker edition-also">Also unfinished</p>
            <ul className="edition-also-list">
              {(showAll ? resumable.slice(1) : resumable.slice(1, RESUME_VISIBLE)).map((item) => (
                <ContinueRow key={item.key} item={item} now={watchingNow} onOpen={(alt) => open(item, alt)} />
              ))}
            </ul>
          </>
        )}
        {resumable.length > RESUME_VISIBLE && (
          <button type="button" className="relay-recap-toggle relay-more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `Show all ${resumable.length}`}
          </button>
        )}
      </>
    )}
  </section>

  <aside className="edition-side">
    <TriageCard />
    <p className="edition-quote">{quoteOfDay(localDate())}</p>
  </aside>

  <footer className="edition-index">
    <BookmarksPanel />
    <div className="edition-actions">
      <button className="edition-link" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL(PAPERS_PAGE_PATH) })}>Papers</button>
      <button className="edition-link" onClick={() => void chrome.runtime.openOptionsPage()}>Settings</button>
      {focus.active ? (
        <span className="edition-focus-live">
          Focus <strong>{focus.countdown}</strong>
          <button className="edition-pill" onClick={() => void focus.stop(true)}>Stop</button>
        </span>
      ) : (
        <button className="edition-pill" onClick={() => void focus.start(settings.focusMinutes)}>
          Start {settings.focusMinutes}-minute focus
        </button>
      )}
    </div>
  </footer>
</main>
```

with the existing open logic hoisted into one helper inside the component:

```ts
const open = (item: ResumableItem, alt: boolean) => {
  if (item.paper) void chrome.tabs.create({ url: paperOpenUrl(item.paper, alt) });
  else if (item.progress) void openResume(resumeContextFromProgress(item.progress));
};
```

Delete the `.relay-focus-row` and `.relay-commands` blocks and the `Icon` import if unused. Update the component doc comment to describe the front page (masthead, lead, sidebar, index).

- [ ] **Step 8: Sidebar stories and index row markup**

`TriageCard.tsx`: change the root to `<section className="edition-feed" aria-labelledby="feed-title">`, its title to `<h2 id="feed-title" className="edition-kicker">From your feeds</h2>`, and each pick's open button to carry `data-story` and the classes `edition-story` (button), `edition-story-title` (title span), `edition-story-meta` (source · minutes), `edition-story-why` (the reason line). Keep every handler and the probe recording exactly as they are.

`BookmarksPanel.tsx`: keep all state and handlers. Change the visible markup to a single row: `<section className="edition-favorites" aria-labelledby="bookmark-links-title">` containing `<h2 id="bookmark-links-title" className="edition-kicker">Favorites</h2>`, a `<ul className="edition-fav-list">` of links (`<a className="edition-fav" href={link.url}>` with the existing favicon `<img className="bm-favicon">` at 16px and the title), and the existing Add/Edit buttons restyled as `edition-link`. Groups render as `edition-fav-group` spans with the group name as a muted label inside the same row. The add form keeps its fields and validation and opens below the row.

`NowWatching.tsx`: add `<span className="edition-kicker edition-live">Live</span>` as the first child of `.nw-head`.

- [ ] **Step 9: Rewrite `src/pages/newtab/newtab.css`**

Delete the `relay-hero`, `relay-commands`, `relay-command`, `relay-focus-row`, `relay-columns`, `relay-continue`, `relay-bookmarks*`, `bm-grid`/`bm-tile*` and card-surface rules. Keep the `nw-*`, `relay-row*`, `relay-recap*`, `relay-triage*` rules, moved onto tokens. Add:

```css
body {
  background: var(--bg-page);
  color: var(--text-primary);
  font-family: var(--font-sans);
}
.edition {
  row-gap: var(--space-5);
  padding-block: var(--space-6) var(--space-7);
  align-content: start;
}
.edition-masthead {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: end;
  border-bottom: 3px double var(--rule);
  padding-bottom: var(--space-2);
}
.edition-dateline,
.edition-weatherline {
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--leading-sm);
  color: var(--text-muted);
}
.edition-weatherline {
  justify-self: end;
  display: flex;
  gap: var(--space-3);
}
.edition-name {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-3xl);
  line-height: var(--leading-3xl);
  font-weight: 700;
  text-align: center;
}
.edition-dek {
  grid-column: 1 / -1;
  display: flex;
  justify-content: space-between;
  margin: 0;
  padding-top: var(--space-2);
  border-top: 1px solid var(--border);
  font-size: var(--text-sm);
  line-height: var(--leading-sm);
  color: var(--text-muted);
}
.relay-watching-card {
  grid-column: 1 / -1;
}
.edition-lead-col {
  grid-column: 1 / span 8;
}
.edition-side {
  grid-column: 9 / -1;
  border-left: 1px solid var(--border);
  padding-left: var(--space-5);
}
.edition-index {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--space-5);
  border-top: 3px double var(--rule);
  padding-top: var(--space-3);
}
.edition-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.edition-kicker {
  margin: 0;
  font-size: var(--text-xs);
  line-height: var(--leading-xs);
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent-text);
}
.edition-lead {
  all: unset;
  display: block;
  width: 100%;
  cursor: pointer;
}
.edition-lead-text {
  display: grid;
  gap: var(--space-2);
}
.edition-headline,
.edition-story-title {
  font-family: var(--font-display);
  font-weight: 700;
  color: var(--text-primary);
  text-decoration: underline transparent;
  text-underline-offset: 4px;
  transition: text-decoration-color var(--transition-fast) var(--ease-out);
}
.edition-headline {
  font-size: var(--text-2xl);
  line-height: var(--leading-2xl);
}
.edition-lead:hover .edition-headline,
.edition-lead:focus-visible .edition-headline,
.edition-story:hover .edition-story-title,
.edition-story:focus-visible .edition-story-title {
  text-decoration-color: var(--accent);
}
.edition-lead-status {
  font-size: var(--text-md);
  line-height: var(--leading-md);
  color: var(--text-muted);
}
.edition-cta {
  justify-self: start;
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-pill);
  background: var(--rule);
  color: var(--bg-page);
  font-size: var(--text-sm);
  line-height: var(--leading-sm);
  font-weight: 700;
}
.edition-cta kbd {
  font: inherit;
  font-weight: 400;
  opacity: 0.7;
  margin-left: var(--space-2);
}
.edition-also {
  margin-top: var(--space-5);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
}
.edition-story {
  all: unset;
  display: grid;
  gap: var(--space-1);
  width: 100%;
  padding-block: var(--space-3);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.edition-story-title {
  font-size: var(--text-md);
  line-height: var(--leading-md);
}
.edition-story-meta,
.edition-story-why {
  font-size: var(--text-xs);
  line-height: var(--leading-xs);
  color: var(--text-muted);
}
.edition-quote {
  margin-top: var(--space-5);
  font-family: var(--font-display);
  font-style: italic;
  font-size: var(--text-md);
  line-height: var(--leading-md);
  color: var(--text-muted);
}
.edition-notice {
  margin: 0;
  padding: var(--space-5);
  border: 1px solid var(--border);
  font-family: var(--font-display);
  font-size: var(--text-lg);
  line-height: var(--leading-lg);
}
.edition-pill {
  padding: var(--space-1) var(--space-4);
  border: 1px solid var(--rule);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-sm);
  line-height: var(--leading-sm);
  font-weight: 700;
  cursor: pointer;
}
.edition-link {
  background: none;
  border: 0;
  padding: 0;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--text-sm);
  line-height: var(--leading-sm);
  cursor: pointer;
}
.edition-favorites {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.edition-fav-list {
  display: flex;
  gap: var(--space-4);
  list-style: none;
  margin: 0;
  padding: 0;
}
.edition-fav {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-primary);
  text-decoration: none;
  font-size: var(--text-sm);
  line-height: var(--leading-sm);
}
.edition-fav:hover {
  color: var(--accent-text);
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* The page prints in: masthead, then lead, then sidebar. */
@keyframes edition-rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
.edition-masthead,
.edition-lead-col,
.edition-side {
  animation: edition-rise 300ms var(--ease-out) both;
}
.edition-lead-col {
  animation-delay: 60ms;
}
.edition-side {
  animation-delay: 120ms;
}
@media (prefers-reduced-motion: reduce) {
  .edition-masthead,
  .edition-lead-col,
  .edition-side {
    animation: none;
  }
}
@media (max-width: 900px) {
  .edition-lead-col,
  .edition-side {
    grid-column: 1 / -1;
  }
  .edition-side {
    border-left: 0;
    padding-left: 0;
    border-top: 1px solid var(--border);
    padding-top: var(--space-4);
  }
  .edition-masthead {
    grid-template-columns: 1fr;
    text-align: center;
  }
  .edition-weatherline {
    justify-self: center;
  }
}
```

The `.relay-row-meter` fill uses `background: var(--accent)`; the track uses `var(--border)`.

- [ ] **Step 10: Lint, typecheck, test**

Delete `'src/pages/newtab/newtab.css'` from `PENDING`. Run: `npm run typecheck && npx vitest run`
Expected: PASS. Fix any `newtab.css` violations the sweep lists, using the rules in Task 4 Step 2.

- [ ] **Step 11: Drive it**

Build, then extend the scratchpad screenshot script (pattern in `.claude/skills/verify/SKILL.md`) to: seed two `readingProgress` article entries (fields per `ReadingProgress` in `src/shared/types.ts`: `url,title,source,maxPercent,activeSeconds,firstOpenedAt,updatedAt,completedAt:null,nudge:{count:0,lastAt:0,dismissed:false},kind:'article',feedItemId:null,scrollY:0,pageHeight:1000`), one bookmark, and `settings.displayName`; screenshot at 1440×900 and 800×900 in light and dark; press `j` twice and assert `document.activeElement` carries `data-story`; type `j` into the bookmark Add field and assert the selection did not move; collect console errors.
Expected: masthead, lead and sidebar sit on shared column lines; zero console errors.

- [ ] **Step 12: Commit**

```bash
git commit -m "The new tab as a front page: masthead, lead story, feed sidebar, index

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/pages/newtab src/shared/keys.ts src/shared/keys.test.ts src/shared/designSystem.test.ts
```

---

### Task 6: Reading-aid logic (pure)

**Files:**
- Create: `src/shared/readingAids.ts`, `src/shared/readingAids.test.ts`
- Modify: `src/shared/pdfOutline.ts` (add `sectionIndexAt`; `headingForPage` uses it)
- Modify: `src/shared/pdfOutline.test.ts`
- Modify: `src/pages/reader/components/OutlineSidebar.tsx` (replace local `activeIndex` with `sectionIndexAt`)

**Interfaces:**
- Produces:
  - `sectionIndexAt(flat: FlatOutlineItem[], page: number): number`, -1 before the first heading.
  - `wordCounts(passages: readonly string[]): number[]`
  - `minutesLeft(counts: readonly number[] | null, index: number, fraction: number): number | null` (`index` 0-based, `fraction` 0–1 through that passage; 230 wpm; ceil)
  - `timeLeftLabel(minutes: number | null): string` → `''` | `'almost done'` | `'about N min left'`
  - `crossedSection(prev: number, next: number): number | null` → the finished index when `next === prev + 1 && prev >= 0`
  - `sectionDoneLabel(finished: number, total: number): string`
  - `DRIFT_IDLE_MS = 180_000`, `DRIFT_AWAY_MS = 120_000`
  - `type DriftEvent = { type: 'activity' | 'hidden' | 'visible' | 'tick'; at: number }`
  - `interface DriftState { lastActivity: number; hiddenAt: number | null; nudged: boolean }`
  - `driftStep(state: DriftState, event: DriftEvent): { state: DriftState; nudge: boolean }`

- [ ] **Step 1: Write the failing tests**

`src/shared/readingAids.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  crossedSection,
  DRIFT_AWAY_MS,
  DRIFT_IDLE_MS,
  driftStep,
  minutesLeft,
  sectionDoneLabel,
  timeLeftLabel,
  wordCounts,
  type DriftState,
} from './readingAids';

describe('minutesLeft', () => {
  const counts = wordCounts(['one two three four', 'x '.repeat(460), 'y '.repeat(230)]);

  it('counts words, ignoring extra whitespace', () => {
    expect(counts).toEqual([4, 460, 230]);
  });

  it('counts the rest of the current passage plus everything after it at 230 wpm', () => {
    expect(minutesLeft(counts, 1, 0)).toBe(3);
    expect(minutesLeft(counts, 1, 0.5)).toBe(2);
    expect(minutesLeft(counts, 2, 1)).toBe(0);
  });

  it('is null until the text exists', () => {
    expect(minutesLeft(null, 0, 0)).toBeNull();
  });

  it('clamps an index past the end', () => {
    expect(minutesLeft(counts, 9, 0)).toBe(0);
  });
});

describe('timeLeftLabel', () => {
  it('says nothing without an estimate, and never "0 min"', () => {
    expect(timeLeftLabel(null)).toBe('');
    expect(timeLeftLabel(0)).toBe('almost done');
    expect(timeLeftLabel(11)).toBe('about 11 min left');
  });
});

describe('crossedSection', () => {
  it('reports a section finished by reading forward into the next one', () => {
    expect(crossedSection(2, 3)).toBe(2);
  });

  it('stays quiet for jumps, backtracking, and documents without an outline', () => {
    expect(crossedSection(2, 5)).toBeNull();
    expect(crossedSection(3, 2)).toBeNull();
    expect(crossedSection(-1, 0)).toBeNull();
    expect(crossedSection(-1, -1)).toBeNull();
    expect(crossedSection(2, 2)).toBeNull();
  });
});

describe('sectionDoneLabel', () => {
  it('counts what is left', () => {
    expect(sectionDoneLabel(2, 6)).toBe('Section 3 done · 3 left');
    expect(sectionDoneLabel(4, 6)).toBe('Section 5 done · 1 left');
    expect(sectionDoneLabel(5, 6)).toBe('Last section done');
  });
});

describe('driftStep', () => {
  const start: DriftState = { lastActivity: 0, hiddenAt: null, nudged: false };
  const run = (events: [DriftEvent['type'], number][]) => {
    let state = start;
    return events.map(([type, at]) => {
      const out = driftStep(state, { type, at });
      state = out.state;
      return out.nudge;
    });
  };
  type DriftEvent = Parameters<typeof driftStep>[1];

  it('nudges once after idling in view, and not again until there is activity', () => {
    expect(run([['tick', DRIFT_IDLE_MS - 1], ['tick', DRIFT_IDLE_MS], ['tick', DRIFT_IDLE_MS + 60_000]])).toEqual([false, true, false]);
  });

  it('re-arms after activity', () => {
    expect(run([['tick', DRIFT_IDLE_MS], ['activity', DRIFT_IDLE_MS + 1], ['tick', 2 * DRIFT_IDLE_MS + 1]])).toEqual([true, false, true]);
  });

  it('nudges on return from a long absence, once', () => {
    expect(run([['hidden', 1000], ['visible', 1000 + DRIFT_AWAY_MS + 1], ['tick', 1000 + DRIFT_AWAY_MS + 2]])).toEqual([false, true, false]);
  });

  it('does not nudge for a short tab switch, and does not count idle time while hidden', () => {
    expect(run([['hidden', 1000], ['tick', 1000 + DRIFT_IDLE_MS], ['visible', 1000 + DRIFT_AWAY_MS - 1]])).toEqual([false, false, false]);
  });
});
```

Append to `src/shared/pdfOutline.test.ts` (add `sectionIndexAt` to the import):

```ts
describe('sectionIndexAt', () => {
  const flat = [
    { title: 'Intro', level: 0, page: 1 },
    { title: 'Method', level: 0, page: 3 },
    { title: 'Ablations', level: 1, page: 3 },
    { title: 'Results', level: 0, page: 6 },
  ];

  it('is the last heading at or before the page', () => {
    expect(sectionIndexAt(flat, 1)).toBe(0);
    expect(sectionIndexAt(flat, 4)).toBe(2);
    expect(sectionIndexAt(flat, 9)).toBe(3);
  });

  it('is -1 before the first heading and for an empty outline', () => {
    expect(sectionIndexAt([{ title: 'Late', level: 0, page: 2 }], 1)).toBe(-1);
    expect(sectionIndexAt([], 5)).toBe(-1);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run src/shared/readingAids.test.ts src/shared/pdfOutline.test.ts`
Expected: FAIL (modules/exports missing).

- [ ] **Step 3: Implement**

`src/shared/readingAids.ts`:

```ts
/*
 * The reader's anti-drift aids as pure decisions: how long is left, whether a
 * section was just finished, and whether attention has wandered. Components
 * only feed in events and render what comes back.
 */

const WORDS_PER_MINUTE = 230;

export function wordCounts(passages: readonly string[]): number[] {
  return passages.map((p) => p.split(/\s+/).filter(Boolean).length);
}

/** Minutes to the end from passage `index` (0-based), `fraction` of the way through it. */
export function minutesLeft(counts: readonly number[] | null, index: number, fraction: number): number | null {
  if (!counts) return null;
  if (index >= counts.length) return 0;
  let words = counts[index] * (1 - Math.min(1, Math.max(0, fraction)));
  for (let i = index + 1; i < counts.length; i++) words += counts[i];
  return Math.ceil(words / WORDS_PER_MINUTE);
}

export function timeLeftLabel(minutes: number | null): string {
  if (minutes === null) return '';
  return minutes === 0 ? 'almost done' : `about ${minutes} min left`;
}

/** Reading forward into the next section finishes the previous one; jumps do not count. */
export function crossedSection(prev: number, next: number): number | null {
  return prev >= 0 && next === prev + 1 ? prev : null;
}

export function sectionDoneLabel(finished: number, total: number): string {
  const left = total - finished - 1;
  return left <= 0 ? 'Last section done' : `Section ${finished + 1} done · ${left} left`;
}

export const DRIFT_IDLE_MS = 180_000;
export const DRIFT_AWAY_MS = 120_000;

export type DriftEvent = { type: 'activity' | 'hidden' | 'visible' | 'tick'; at: number };

export interface DriftState {
  lastActivity: number;
  hiddenAt: number | null;
  /** Set when a nudge fires; cleared by activity, so it fires once per drift. */
  nudged: boolean;
}

export function driftStep(state: DriftState, event: DriftEvent): { state: DriftState; nudge: boolean } {
  switch (event.type) {
    case 'activity':
      return { state: { ...state, lastActivity: event.at, nudged: false }, nudge: false };
    case 'hidden':
      return { state: { ...state, hiddenAt: event.at }, nudge: false };
    case 'visible': {
      const away = state.hiddenAt !== null && event.at - state.hiddenAt > DRIFT_AWAY_MS;
      const nudge = away && !state.nudged;
      return { state: { lastActivity: event.at, hiddenAt: null, nudged: state.nudged || nudge }, nudge };
    }
    case 'tick': {
      const nudge = state.hiddenAt === null && !state.nudged && event.at - state.lastActivity >= DRIFT_IDLE_MS;
      return { state: nudge ? { ...state, nudged: true } : state, nudge };
    }
  }
}
```

In `src/shared/pdfOutline.ts`, add and reuse:

```ts
/** Index of the heading the reader is "in" on `page`; -1 before the first heading. */
export function sectionIndexAt(flat: FlatOutlineItem[], page: number): number {
  let best = -1;
  for (let i = 0; i < flat.length; i++) {
    if (flat[i].page <= page && (best === -1 || flat[i].page >= flat[best].page)) best = i;
  }
  return best;
}

export function headingForPage(flat: FlatOutlineItem[], page: number): string | null {
  const i = sectionIndexAt(flat, page);
  return i === -1 ? null : flat[i].title;
}
```

(Keep `headingForPage`'s existing doc comment.) In `OutlineSidebar.tsx`, delete the local `activeIndex` function and use `sectionIndexAt(outline, currentPage)` imported from `../../../shared/pdfOutline`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/shared/readingAids.test.ts src/shared/pdfOutline.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "Pure reading-aid logic: time left, section crossing, drift

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/shared/readingAids.ts src/shared/readingAids.test.ts src/shared/pdfOutline.ts src/shared/pdfOutline.test.ts src/pages/reader/components/OutlineSidebar.tsx
```

---

### Task 7: Observatory reader shell

**Files:**
- Create: `src/pages/reader/components/ReaderCapsule.tsx`
- Create: `src/pages/reader/useChromeAwake.ts`
- Modify: `src/pages/reader/components/ReaderToolbar.tsx` (move pagination + zoom out to the capsule)
- Modify: `src/pages/reader/components/TrackPrompt.tsx` (chip + popover)
- Modify: `src/pages/reader/PdfReader.tsx`, `src/pages/reader/ArticleReader.tsx`
- Modify: `src/pages/reader/reader.css`
- Modify: `src/shared/designSystem.test.ts` (remove `reader.css` from `PENDING`)

**Interfaces:**
- Consumes: `wordCounts`, `minutesLeft`, `timeLeftLabel` (Task 6).
- Produces:
  - `useChromeAwake(pinned: boolean): boolean` (true = toolbar visible)
  - `ReaderCapsule(props: { label: string; progress: number; page?: number; pageCount?: number; pageNoun: 'page' | 'block'; onPageJump?: (page: number) => void; zoom?: number; onZoom?: (zoom: number) => void; message?: string | null; action?: { label: string; run: () => void } | null; children?: ReactNode })`. `progress` is 0–1. `message`/`action` drive the transient states Tasks 9 and 11 add. `children` holds the tracking chip.
  - The reader root gets `data-chrome="awake" | "asleep"`.

- [ ] **Step 1: `useChromeAwake`**

```ts
// src/pages/reader/useChromeAwake.ts
import { useEffect, useState } from 'react';

const IDLE_MS = 2500;
const WAKE_ZONE_PX = 48;

/**
 * Whether the reader's toolbar should show. It sleeps after a moment of
 * reading and wakes at the top edge or on scroll-up — the page is the
 * interface. `pinned` (a panel open, or focus inside the toolbar) keeps it
 * awake; reduced motion keeps it awake for good.
 */
export function useChromeAwake(pinned: boolean): boolean {
  const [awake, setAwake] = useState(true);
  useEffect(() => {
    if (pinned || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setAwake(true);
      return;
    }
    let timer = self.setTimeout(() => setAwake(false), IDLE_MS);
    const wake = () => {
      setAwake(true);
      clearTimeout(timer);
      timer = self.setTimeout(() => setAwake(false), IDLE_MS);
    };
    const onMove = (e: PointerEvent) => {
      if (e.clientY <= WAKE_ZONE_PX) wake();
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) wake();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('wheel', onWheel);
    };
  }, [pinned]);
  return awake;
}
```

- [ ] **Step 2: `ReaderCapsule`**

Move the pagination JSX (`.reader-pagination` with prev/next/page-jump and the `pageDraft` state, `jumpToDraft`) and the zoom JSX (`.reader-zoom-controls`) out of `ReaderToolbar.tsx` into this component verbatim, behind an expanded state:

```tsx
// src/pages/reader/components/ReaderCapsule.tsx
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ZOOM_MAX, ZOOM_MIN } from './ReaderToolbar';

/**
 * Where you are and how long is left, floating under the page. Click to open
 * page jump and zoom in place; Escape folds it back. It also carries the
 * reader's quiet announcements (a section finished, "you were here").
 */
export function ReaderCapsule({
  label,
  progress,
  page,
  pageCount,
  pageNoun,
  onPageJump,
  zoom,
  onZoom,
  message = null,
  action = null,
  children,
}: {
  label: string;
  progress: number;
  page?: number;
  pageCount?: number;
  pageNoun: 'page' | 'block';
  onPageJump?: (page: number) => void;
  zoom?: number;
  onZoom?: (zoom: number) => void;
  message?: string | null;
  action?: { label: string; run: () => void } | null;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  return (
    <>
      <div className="reader-progress-line" style={{ transform: `scaleX(${Math.min(1, Math.max(0, progress))})` }} aria-hidden="true" />
      <div ref={ref} className="reader-capsule" data-open={open || undefined} data-message={message ? '' : undefined} role="status" aria-live="polite">
        {message ? (
          <>
            <span className="reader-capsule-message">{message}</span>
            {action && (
              <button type="button" className="reader-capsule-action" onClick={action.run}>
                {action.label}
              </button>
            )}
          </>
        ) : open ? (
          <>{/* the moved pagination group, then the moved zoom group */}</>
        ) : (
          <button type="button" className="reader-capsule-summary" aria-expanded={false} onClick={() => setOpen(true)}>
            <span className="reader-capsule-dot" aria-hidden="true" />
            {label}
          </button>
        )}
        {children}
      </div>
    </>
  );
}
```

Paste the moved pagination and zoom JSX where the `open` branch comment is, keeping their `aria-label`s, `title`s and handlers; `ZOOM_MIN`/`ZOOM_MAX` stay exported from `ReaderToolbar.tsx`. Delete `.reader-toolbar-center` and its contents from the toolbar; the toolbar keeps its keyboard zoom shortcuts (`onZoom`/`zoom` props stay on it for that). Remove `page`, `pageCount`, `pageNoun`, `onPageJump` props from `ReaderToolbar` only if nothing else in it uses them (the night-mode check uses `pageNoun`; keep `pageNoun`).

- [ ] **Step 3: Wire it into both readers**

In `PdfReader.tsx`:

```ts
const counts = useMemo(() => (pageTexts ? wordCounts(pageTexts) : null), [pageTexts]);
const minutes = minutesLeft(counts, position.page - 1, position.offset);
const label = [`p. ${position.page} of ${pageCount}`, timeLeftLabel(minutes)].filter(Boolean).join(' · ');
const progress = pageCount > 0 ? (position.page - 1 + position.offset) / pageCount : 0;
const awake = useChromeAwake(panel !== 'none' || noteMode || outlineOpen);
```

Set `data-chrome={awake ? 'awake' : 'asleep'}` on `.reader-root`. Render `<ReaderCapsule label={label} progress={progress} page={position.page} pageCount={pageCount} pageNoun="page" onPageJump={(p) => viewportRef.current?.scrollToPosition(p, 0)} zoom={zoom} onZoom={setZoom}>{ready && papersLoaded && !paper && <TrackPrompt … />}</ReaderCapsule>` as the last child of `.reader-main`, and remove the old `TrackPrompt` render above `.reader-body`. Turn the scanned-PDF notice and note-mode banner into `<div className="reader-toast" role="status">…</div>` rendered inside `.reader-main` (same text and buttons).

In `ArticleReader.tsx`, the same with `passages` and `const awake = useChromeAwake(panel !== 'none' || outlineOpen);`:

```ts
const counts = useMemo(() => (passages ? wordCounts(passages) : null), [passages]);
const [percent, setPercent] = useState(0);
// in onProgress: setPercent(percent) alongside setBlockIndex
const label = [`${Math.round(percent)}%`, timeLeftLabel(minutesLeft(counts, blockIndex, 0))].filter(Boolean).join(' · ');
```

and `<ReaderCapsule label={label} progress={percent / 100} page={blockIndex + 1} pageCount={blocks.length} pageNoun="block" onPageJump={(b) => viewportRef.current?.scrollToBlock(b - 1)} />`.

- [ ] **Step 4: Tracking chip**

In `TrackPrompt.tsx`, replace the `.reader-track-banner` wrapper with a chip button `<button type="button" className="reader-track-chip" aria-expanded={formOpen} onClick={() => setFormOpen(v => !v)}>Not tracked · Track</button>` and render the existing form inside `<div className="reader-track-popover" role="dialog" aria-label="Track this paper">` only while `formOpen`. Reuse whatever state already toggles the form (read the component; if the banner had a one-click "Track this paper" that submitted directly, keep that button inside the popover as its primary action).

- [ ] **Step 5: `reader.css`**

Delete `'src/pages/reader/reader.css'` from `PENDING`, run the sweep, and fix every violation with the Task 4 Step 2 rules. Then add/replace:

```css
.reader-root {
  position: relative;
  height: 100vh;
  background: var(--bg-page);
}
.reader-toolbar {
  position: absolute;
  inset: 0 0 auto 0;
  z-index: 20;
  background: var(--material-thin);
  backdrop-filter: var(--glass-blur);
  border-bottom: 1px solid var(--border-subtle);
  transition: opacity 300ms var(--ease-out), transform 300ms var(--ease-out);
}
.reader-root[data-chrome='asleep'] .reader-toolbar:not(:focus-within):not(:hover) {
  opacity: 0;
  transform: translateY(-100%);
  pointer-events: none;
}
.reader-body {
  height: 100%;
  position: relative;
}
.reader-main {
  position: relative;
  height: 100%;
}
.reader-viewport:focus {
  /* Programmatic focus on load is for the keyboard scroll, not a selection. */
  outline: none;
}
.reader-progress-line {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  z-index: 30;
  background: var(--accent);
  box-shadow: var(--shadow-accent);
  transform-origin: left;
  transition: transform 200ms linear;
}
.reader-capsule {
  position: absolute;
  bottom: var(--space-5);
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-pill);
  background: var(--material-regular);
  backdrop-filter: var(--glass-blur);
  box-shadow: var(--shadow-card);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: var(--leading-sm);
}
.reader-capsule-summary {
  all: unset;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
}
.reader-capsule-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
}
.reader-capsule[data-message] {
  color: var(--text-primary);
  animation: capsule-pulse 600ms var(--ease-out) 1;
}
@keyframes capsule-pulse {
  50% {
    box-shadow: var(--shadow-card), 0 0 0 4px var(--accent-wash);
  }
}
.reader-capsule-action {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  font-weight: 700;
  color: var(--accent-text);
  cursor: pointer;
}
.reader-track-chip {
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-muted);
  padding: 0 var(--space-2);
  font: inherit;
  font-size: var(--text-xs);
  line-height: var(--leading-xs);
  cursor: pointer;
}
.reader-track-popover {
  position: absolute;
  bottom: calc(100% + var(--space-3));
  left: 50%;
  transform: translateX(-50%);
  width: 360px;
  padding: var(--space-4);
  border-radius: var(--radius-xl);
  background: var(--material-thick);
  box-shadow: var(--shadow-lg);
}
.reader-toast {
  position: absolute;
  bottom: calc(var(--space-5) + var(--space-7));
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-lg);
  background: var(--material-regular);
  box-shadow: var(--shadow-card);
  font-size: var(--text-sm);
  line-height: var(--leading-sm);
}
/* Side panels slide over the page instead of resizing it. */
.reader-outline,
.reader-annotations,
.ask-sheet,
.reader-find {
  position: absolute;
  top: var(--space-7);
  bottom: var(--space-3);
  z-index: 15;
  background: var(--material-regular);
  backdrop-filter: var(--glass-blur);
  box-shadow: var(--shadow-lg);
  border-radius: var(--radius-xl);
}
.reader-outline {
  left: var(--space-3);
  width: 280px;
}
.reader-annotations,
.ask-sheet,
.reader-find {
  right: var(--space-3);
  width: 360px;
}
.article-body {
  max-width: 68ch;
  margin-inline: auto;
  font-size: var(--text-md);
  line-height: 28px;
}
.article-heading {
  font-family: var(--font-display);
}
@media (prefers-reduced-motion: reduce) {
  .reader-toolbar,
  .reader-progress-line {
    transition: none;
  }
  .reader-capsule[data-message] {
    animation: none;
  }
}
```

Check the real class names of the Ask, Find and Annotations panels with `grep -n "className=\"" src/pages/reader/components/{AskSheet,PdfFindPanel,AnnotationsSidebar}.tsx | head` and use those in the overlay selector. `line-height: 28px` on `.article-body` is a multiple of 4 but not a token: add `--leading-read: 28px` to `:root` in `theme.css` and use `var(--leading-read)` (the lint only accepts `--leading-*` tokens).

- [ ] **Step 6: Typecheck, test, drive**

Run: `npm run typecheck && npx vitest run && npm run build > /tmp/build.log 2>&1; echo $?`
Expected: all green.
Drive with the verify-reader pattern (`src/pages/reader/index.html?src=https%3A%2F%2Farxiv.org%2Fpdf%2F1706.03762`, wait for `.reader-canvas[data-ready]`): wait 3s, assert `.reader-root[data-chrome="asleep"]`; `page.mouse.move(700, 10)` and assert `awake`; click `.reader-capsule-summary` and assert the page-jump input is visible; press Escape and assert it folded; assert no `.reader-track-banner`; screenshot light and dark; zero console errors. Repeat the screenshot for `?article=` with a Wikipedia URL.

- [ ] **Step 7: Commit**

```bash
git commit -m "Observatory reader: hiding chrome, progress line, status capsule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/pages/reader src/shared/theme.css src/shared/designSystem.test.ts
```

---

### Task 8: Outline rail and section finish

**Files:**
- Create: `src/pages/reader/components/OutlineRail.tsx`
- Modify: `src/pages/reader/PdfReader.tsx`, `src/pages/reader/ArticleReader.tsx`
- Modify: `src/pages/reader/reader.css`

**Interfaces:**
- Consumes: `sectionIndexAt`, `FlatOutlineItem` (Task 6 / `pdfOutline.ts`), `crossedSection`, `sectionDoneLabel` (Task 6), `ReaderCapsule`'s `message` prop (Task 7).
- Produces: `OutlineRail({ sections, current, onJump }: { sections: FlatOutlineItem[]; current: number; onJump: (page: number) => void })`; `useSectionToast(sections: FlatOutlineItem[], position: number): string | null`.

- [ ] **Step 1: Rail component and toast hook**

```tsx
// src/pages/reader/components/OutlineRail.tsx
import { useEffect, useRef, useState } from 'react';
import type { FlatOutlineItem } from '../../../shared/pdfOutline';
import { crossedSection, sectionDoneLabel } from '../../../shared/readingAids';

/**
 * The outline folded to tick marks on the left edge: one per top-level
 * section, passed ones filled, the current one lit. Hover to read the names.
 */
export function OutlineRail({
  sections,
  current,
  onJump,
}: {
  sections: FlatOutlineItem[];
  current: number;
  onJump: (page: number) => void;
}) {
  if (sections.length === 0) return null;
  return (
    <nav className="reader-rail" aria-label="Sections">
      <ol>
        {sections.map((s, i) => (
          <li key={`${s.page}-${i}`}>
            <button
              type="button"
              className="reader-rail-tick"
              data-state={i < current ? 'done' : i === current ? 'current' : undefined}
              aria-current={i === current ? 'location' : undefined}
              onClick={() => onJump(s.page)}
            >
              <span className="reader-rail-label">{s.title}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** "Section 3 done · 2 left" for three seconds after reading into the next section. */
export function useSectionToast(sections: FlatOutlineItem[], current: number): string | null {
  const prev = useRef(current);
  const mountedAt = useRef(Date.now());
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    const finished = crossedSection(prev.current, current);
    prev.current = current;
    // ponytail: a time guard, not a "restored" signal. Reopening a paper scrolls
    // to where you were, which can cross exactly one section; that is not
    // reading. Thread the readers' restore flag through if 3s ever misfires.
    if (finished === null || Date.now() - mountedAt.current < 3000) return;
    setToast(sectionDoneLabel(finished, sections.length));
    const timer = self.setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [current, sections.length]);
  return toast;
}
```

- [ ] **Step 2: Wire into both readers**

PDF (`position.page` is 1-based, matching `FlatOutlineItem.page`):

```ts
const sections = useMemo(() => outline.filter((s) => s.level === 0), [outline]);
const sectionIndex = sectionIndexAt(sections, position.page);
const sectionToast = useSectionToast(sections, sectionIndex);
```

Render `{ready && !outlineOpen && <OutlineRail sections={sections} current={sectionIndex} onJump={(p) => viewportRef.current?.scrollToPosition(p, 0)} />}` inside `.reader-main`, and pass `message={sectionToast}` to `ReaderCapsule`.

Article: the same with `state.outline` and `blockIndex` (the outline's `page` is a block index there, the same unit `OutlineSidebar` already receives as `currentPage`), jumping with `viewportRef.current?.scrollToBlock(p)`.

Change both readers' initial `outlineOpen` state to `false`, so the rail is what a reader sees first and the full panel stays one click away.

- [ ] **Step 3: Rail CSS**

```css
.reader-rail {
  position: absolute;
  left: var(--space-4);
  top: 50%;
  transform: translateY(-50%);
  z-index: 10;
}
.reader-rail ol {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-3);
}
.reader-rail-tick {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--text-xs);
  line-height: var(--leading-xs);
}
.reader-rail-tick::before {
  content: '';
  width: 16px;
  height: 2px;
  border-radius: 50%;
  background: var(--border);
  transition: width var(--transition-base) var(--ease-out), background var(--transition-base);
}
.reader-rail-tick[data-state='done']::before {
  background: var(--text-muted);
}
.reader-rail-tick[data-state='current']::before {
  width: 28px;
  background: var(--accent);
  box-shadow: var(--shadow-accent);
}
.reader-rail-label {
  opacity: 0;
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: opacity var(--transition-base);
}
.reader-rail:hover .reader-rail-label,
.reader-rail-tick:focus-visible .reader-rail-label {
  opacity: 1;
}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npx vitest run`. Expected: PASS.
Drive the arXiv PDF (it has an outline): assert `.reader-rail-tick` count > 0 and exactly one `[data-state="current"]`; scroll from the first section into the second with `scrollToPosition` via the rail; then scroll forward page by page with `page.keyboard.press('PageDown')` until the current tick changes and assert `.reader-capsule-message` contains "done". Open a PDF with no outline (any arXiv PDF without bookmarks, or skip if none is handy and note it) and assert no `.reader-rail`.

- [ ] **Step 5: Commit**

```bash
git commit -m "Outline rail on the page edge, and a quiet mark when a section is done

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/pages/reader
```

---

### Task 9: Focus line

**Files:**
- Modify: `src/shared/types.ts` (`Settings.readerFocusLine: boolean`)
- Modify: `src/shared/storage.ts` (`DEFAULT_SETTINGS.readerFocusLine: false`)
- Modify: `src/pages/reader/components/ArticleViewport.tsx` (`focusBlock` prop)
- Modify: `src/pages/reader/ArticleReader.tsx`, `src/pages/reader/PdfReader.tsx`
- Create: `src/pages/reader/useFocusLineKey.ts`
- Modify: `src/pages/options/Options.tsx` (Reader section with the toggle)
- Modify: `src/pages/reader/reader.css`

**Interfaces:**
- Consumes: `isTypingTarget` (Task 5), `useSettings`, `patchSettings`.
- Produces: `useFocusLineKey(): boolean` (current setting; `f` toggles it); `ArticleViewport` prop `focusBlock?: number`.

- [ ] **Step 1: Setting**

Add to `Settings` in `types.ts`, after `readerNight`:

```ts
  /** Reader focus line: dim everything but the passage being read (key F) */
  readerFocusLine: boolean;
```

Add `readerFocusLine: false,` after `readerNight: false,` in `DEFAULT_SETTINGS`.

- [ ] **Step 2: Key hook**

```ts
// src/pages/reader/useFocusLineKey.ts
import { useEffect } from 'react';
import { useSettings } from '../../shared/hooks/useSettings';
import { isTypingTarget } from '../../shared/keys';
import { patchSettings } from '../../shared/storage';

/** The focus line setting, toggled with F anywhere in the reader except text fields. */
export function useFocusLineKey(): boolean {
  const [settings] = useSettings();
  const on = settings.readerFocusLine;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'f' || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      void patchSettings({ readerFocusLine: !on });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [on]);
  return on;
}
```

- [ ] **Step 3: Wire it**

`ArticleViewport.tsx`: add `focusBlock?: number` to the props; on each block `<div>`, add `data-current={i === focusBlock || undefined}`.

`ArticleReader.tsx`: `const focusLine = useFocusLineKey();`; set `data-focus-line={focusLine || undefined}` on `.reader-root`; pass `focusBlock={blockIndex}` to `ArticleViewport`.

`PdfReader.tsx`: same hook and attribute; inside `.reader-main` render `{focusLine && <div className="reader-focus-band" aria-hidden="true" />}`.

`Options.tsx`: after the Appearance section, add:

```tsx
<section className="section" id="reader">
  <h2>Reader</h2>
  <div className="setting-row">
    <label htmlFor="focus-line">
      Focus line
      <small>Dims everything but the passage you are reading. Press F in the reader to toggle.</small>
    </label>
    <input
      id="focus-line"
      type="checkbox"
      checked={settings.readerFocusLine}
      onChange={(e) => void patchSettings({ readerFocusLine: e.target.checked })}
    />
  </div>
</section>
```

(Match how the existing checkbox rows put helper text inside their `<label>`; read lines 236–280 of `Options.tsx` and copy that markup.)

- [ ] **Step 4: CSS**

```css
.reader-root[data-focus-line] .article-block:not([data-current]) {
  opacity: 0.4;
  transition: opacity var(--transition-base) var(--ease-out);
}
.reader-focus-band {
  position: absolute;
  inset: 0;
  z-index: 5;
  pointer-events: none;
  background: linear-gradient(
    to bottom,
    var(--reading-dim) 0,
    var(--reading-dim) calc(40% - 64px),
    transparent calc(40% - 32px),
    transparent calc(40% + 32px),
    var(--reading-dim) calc(40% + 64px),
    var(--reading-dim) 100%
  );
}
@media (prefers-reduced-motion: reduce) {
  .reader-root[data-focus-line] .article-block:not([data-current]) {
    transition: none;
  }
}
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npx vitest run`. Expected: PASS.
Drive: open an article, press `f`, assert `.reader-root[data-focus-line]` and that exactly one `.article-block[data-current]` exists; assert `chrome.storage.local` `settings.readerFocusLine === true`; focus the page-jump input in the capsule and type `f`, assert the setting did not flip. Open the PDF, press `f`, assert `.reader-focus-band`; select text through the band with a mouse drag and assert `window.getSelection().toString()` is non-empty. Screenshot both.

- [ ] **Step 6: Commit**

```bash
git commit -m "Focus line: dim everything but the passage you are reading

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/shared/types.ts src/shared/storage.ts src/pages/reader src/pages/options/Options.tsx
```

---

### Task 10: Drift nudge

**Files:**
- Create: `src/pages/reader/useDriftNudge.ts`
- Modify: `src/pages/reader/PdfReader.tsx`, `src/pages/reader/ArticleReader.tsx`

**Interfaces:**
- Consumes: `driftStep`, `DriftState` (Task 6); `ReaderCapsule` `message`/`action` (Task 7); `useSectionToast` output (Task 8).
- Produces: `useDriftNudge<P>(position: P, label: (p: P) => string, restore: (p: P) => void): { message: string; back: () => void } | null`.

- [ ] **Step 1: Hook**

```ts
// src/pages/reader/useDriftNudge.ts
import { useEffect, useRef, useState } from 'react';
import { driftStep, type DriftEvent, type DriftState } from '../../shared/readingAids';

const TICK_MS = 15_000;
const SHOW_MS = 10_000;

/**
 * "You were at 3.2 Attention · Back" after attention wanders: three quiet
 * minutes in view, or a return after two minutes on another tab. The anchor
 * is the position when the drift began, so Back undoes any aimless scrolling.
 */
export function useDriftNudge<P>(
  position: P,
  label: (p: P) => string,
  restore: (p: P) => void,
): { message: string; back: () => void } | null {
  const state = useRef<DriftState>({ lastActivity: Date.now(), hiddenAt: null, nudged: false });
  const anchor = useRef(position);
  const latest = useRef(position);
  latest.current = position;
  // Listeners bind once, so they read the newest label/restore through a ref —
  // the PDF outline arrives after the first render and a captured label would
  // say "page N" forever.
  const fns = useRef({ label, restore });
  fns.current = { label, restore };
  const [nudge, setNudge] = useState<{ message: string; back: () => void } | null>(null);

  useEffect(() => {
    let hideTimer = 0;
    const feed = (type: DriftEvent['type']) => {
      if (type === 'activity' && !state.current.nudged) anchor.current = latest.current;
      if (type === 'hidden') anchor.current = latest.current;
      const out = driftStep(state.current, { type, at: Date.now() });
      state.current = out.state;
      if (!out.nudge) return;
      const target = anchor.current;
      setNudge({
        message: `You were at ${fns.current.label(target)}`,
        back: () => (fns.current.restore(target), setNudge(null)),
      });
      clearTimeout(hideTimer);
      hideTimer = self.setTimeout(() => setNudge(null), SHOW_MS);
    };
    const onActivity = () => feed('activity');
    const onVisibility = () => feed(document.hidden ? 'hidden' : 'visible');
    const tick = self.setInterval(() => !document.hidden && feed('tick'), TICK_MS);
    for (const e of ['scroll', 'keydown', 'pointermove', 'wheel'] as const) {
      window.addEventListener(e, onActivity, { passive: true, capture: true });
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(tick);
      clearTimeout(hideTimer);
      for (const e of ['scroll', 'keydown', 'pointermove', 'wheel'] as const) {
        window.removeEventListener(e, onActivity, { capture: true });
      }
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return nudge;
}
```

- [ ] **Step 2: Wire it**

PDF:

```ts
const drift = useDriftNudge(
  position,
  (p) => headingForPage(outline, p.page) ?? `page ${p.page}`,
  (p) => viewportRef.current?.scrollToPosition(p.page, p.offset),
);
```

Article:

```ts
const drift = useDriftNudge(
  blockIndex,
  (b) => headingForPage(state.status === 'ready' ? state.outline : [], b) ?? `${Math.round(percent)}%`,
  (b) => viewportRef.current?.scrollToBlock(b),
);
```

Pass to the capsule: `message={sectionToast ?? drift?.message ?? null}` and `action={drift && !sectionToast ? { label: 'Back', run: drift.back } : null}`.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npx vitest run`. Expected: PASS.
Drive with Playwright's clock: `await page.clock.install()` before `goto`, load the PDF, `await page.clock.runFor(181_000)` with no input, assert `.reader-capsule-message` text starts with "You were at"; click the action button and assert the message is gone; `await page.clock.runFor(30_000)` and assert it did not reappear. Then simulate a return: `page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); })`, advance the clock 121s, flip `hidden` back to false, dispatch again, and assert the nudge shows once.

- [ ] **Step 4: Commit**

```bash
git commit -m "Drift nudge: a quiet way back when attention wanders

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/pages/reader
```

---

### Task 11: The Library (Papers)

**Files:**
- Modify: `src/pages/papers/Papers.tsx`
- Modify: `src/pages/papers/components/PaperDeckList.tsx` (`selectedId` prop, empty state)
- Modify: `src/pages/papers/components/PaperDeckView.tsx` (deck name as h2)
- Modify: `src/pages/papers/components/PaperRow.tsx` (headline-row classes, page status)
- Modify: `src/pages/papers/papers.css`
- Modify: `src/shared/designSystem.test.ts` (remove `papers.css` from `PENDING`)

**Interfaces:**
- Consumes: `.grid`, tokens, `.fc-primary-btn` (Task 4), `leadStatus` is NOT reused here (papers rows show `Page N of M` only when `paper.pdf` exists, else `N%`, computed inline).
- Produces: `PaperDeckList({ onOpen, selectedId }: { onOpen: (deckId: string) => void; selectedId?: string })`.

- [ ] **Step 1: Page structure (`Papers.tsx`)**

Keep `screenFromHash`, the deleted-deck fallback and the theme toggle. Render:

```tsx
<div className="library grid">
  <header className="library-masthead">
    <button className="ghost-btn" onClick={() => { location.href = chrome.runtime.getURL(NEWTAB_PAGE_PATH); }}>
      ← Today
    </button>
    <h1>Papers</h1>
    <button className="ghost-btn" title={…same as today…} onClick={…same as today…}>
      {theme.resolved === 'dark' ? 'Light' : 'Dark'}
    </button>
  </header>
  <aside className="library-decks">
    <PaperDeckList selectedId={deck?.id} onOpen={(deckId) => setScreen({ name: 'deck', deckId })} />
  </aside>
  <section className="library-papers">
    <RecallSearch />
    {deck ? <PaperDeckView deck={deck} /> : <p className="library-hint">Pick a deck to see its papers.</p>}
  </section>
</div>
```

(The "← Decks" button goes: the deck list is always visible now.)

- [ ] **Step 2: Deck list and rows**

`PaperDeckList`: accept `selectedId`; give each deck row `aria-current={deck.id === selectedId || undefined}`; drop the separate "Open" button (the deck name button opens it); keep delete. Empty state text: "Your library is empty. Name a deck below to start one." `PaperDeckView`: first child `<h2 className="library-deck-name">{deck.name}</h2>`. `PaperRow`: title gets class `library-paper-title`; the meta line `library-paper-meta`; the progress label reads `paper.pdf ? \`Page ${paper.pdf.page} of ${paper.pdf.pageCount}\` : \`${Math.round(paper.progressPercent)}%\``; read the component first and change only class names and that label.

- [ ] **Step 3: `papers.css`**

Delete `papers.css` from `PENDING`, fix every listed violation with the Task 4 Step 2 rules, and add:

```css
.library {
  row-gap: var(--space-5);
  padding-block: var(--space-6);
  align-content: start;
}
.library-masthead {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: end;
  border-bottom: 3px double var(--rule);
  padding-bottom: var(--space-2);
}
.library-masthead h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-2xl);
  line-height: var(--leading-2xl);
}
.library-masthead > :last-child {
  justify-self: end;
}
.library-decks {
  grid-column: 1 / span 4;
}
.library-papers {
  grid-column: 5 / -1;
}
.library-deck-name,
.library-paper-title {
  font-family: var(--font-display);
}
.fc-deck-row[aria-current] .fc-deck-name {
  color: var(--accent-text);
}
@media (max-width: 900px) {
  .library-decks,
  .library-papers {
    grid-column: 1 / -1;
  }
}
```

Convert `.panel` cards inside the library to ruled rows: `border: 0; border-bottom: 1px solid var(--border); border-radius: 0; background: transparent; box-shadow: none;` scoped under `.library`.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npx vitest run`, build, screenshot `papers/index.html` empty, then after adding a deck via the form, and with `#deck=<id>`; zero console errors.

```bash
git commit -m "Papers as a library: decks beside papers on the grid

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/pages/papers src/shared/designSystem.test.ts
```

---

### Task 12: Colophon (Options)

**Files:**
- Modify: `src/pages/options/Options.tsx`, `NewTabSection.tsx`, `LocalAiSection.tsx`, `PapersSection.tsx` (section `id`s)
- Create: `src/pages/options/SectionIndex.tsx`
- Modify: `src/pages/options/options.css`
- Modify: `src/shared/designSystem.test.ts` (remove `options.css` from `PENDING`)

**Interfaces:**
- Produces: `SectionIndex()`, which reads `main section[id] > h2` once on mount and scroll-spies with `IntersectionObserver`.

- [ ] **Step 1: Section ids**

Give every `<section className="section">` an `id` in kebab case of its heading: `appearance`, `reader` (from Task 9), `new-tab`, `local-ai`, `add-feed`, `your-feeds`, `refresh-interval`, `notifications-focus`, `focus-mode`, `research-papers`, `data`, `sample-feeds`.

- [ ] **Step 2: `SectionIndex`**

```tsx
// src/pages/options/SectionIndex.tsx
import { useEffect, useState } from 'react';

/** The sticky table of contents; the section in view is lit. */
export function SectionIndex() {
  const [sections, setSections] = useState<{ id: string; title: string }[]>([]);
  const [active, setActive] = useState('');

  useEffect(() => {
    const nodes = [...document.querySelectorAll<HTMLElement>('main section[id]')];
    setSections(nodes.map((n) => ({ id: n.id, title: n.querySelector('h2')?.textContent ?? n.id })));
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: '0px 0px -70% 0px' },
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, []);

  return (
    <nav className="colophon-index" aria-label="Settings sections">
      <ol>
        {sections.map((s) => (
          <li key={s.id}>
            <a href={`#${s.id}`} aria-current={s.id === active ? 'location' : undefined}>
              {s.title}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
```

In `Options.tsx`, wrap the page in `<div className="colophon grid">` with the existing header as `.colophon-masthead` (h1 text "Settings", serif), `<SectionIndex />`, and `<main className="colophon-main">` holding every section unchanged except ids.

- [ ] **Step 3: `options.css`**

Delete `options.css` from `PENDING`, fix violations with the Task 4 Step 2 rules, and add:

```css
.colophon {
  row-gap: var(--space-5);
  padding-block: var(--space-6);
}
.colophon-masthead {
  grid-column: 1 / -1;
  border-bottom: 3px double var(--rule);
  padding-bottom: var(--space-2);
}
.colophon-masthead h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-2xl);
  line-height: var(--leading-2xl);
}
.colophon-index {
  grid-column: 1 / span 3;
  position: sticky;
  top: var(--space-6);
  align-self: start;
}
.colophon-index ol {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-2);
}
.colophon-index a {
  color: var(--text-muted);
  text-decoration: none;
  font-size: var(--text-sm);
  line-height: var(--leading-sm);
}
.colophon-index a[aria-current] {
  color: var(--accent-text);
  font-weight: 700;
}
.colophon-main {
  grid-column: 4 / span 7;
}
.colophon .section {
  background: none;
  box-shadow: none;
  border-radius: 0;
  padding: 0 0 var(--space-5);
  margin-bottom: var(--space-5);
  border-bottom: 1px solid var(--border);
}
.colophon .section h2 {
  font-family: var(--font-display);
  font-size: var(--text-lg);
  line-height: var(--leading-lg);
  text-transform: none;
  letter-spacing: 0;
}
.colophon .setting-row {
  border-bottom: 1px solid var(--border-subtle);
  padding-block: var(--space-3);
}
@media (max-width: 900px) {
  .colophon-index {
    display: none;
  }
  .colophon-main {
    grid-column: 1 / -1;
  }
}
```

Primary buttons in Options (`Test again` and similar) must use `.fc-primary-btn` or the same ink rules; replace any orange-filled button class's background with `var(--rule)` and color with `var(--bg-page)`.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npx vitest run`, build, screenshot options light/dark, scroll to "Local AI" and assert its index link has `aria-current`; type a city in Weather location, blur, and assert one storage write (commit-on-blur unchanged).

```bash
git commit -m "Settings as a colophon: a sticky index beside ruled sections

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/pages/options src/shared/designSystem.test.ts
```

---

### Task 13: Blocked page

**Files:**
- Modify: `src/pages/blocked/Blocked.tsx` (wrap in grid)
- Modify: `src/pages/blocked/blocked.css`
- Modify: `src/shared/designSystem.test.ts` (remove `blocked.css` from `PENDING`)

- [ ] **Step 1: Markup**

Wrap both returns' content: `<div className="blocked grid"><div className="blocked-inner">…existing children unchanged…</div></div>`. Copy and actions stay as they are.

- [ ] **Step 2: CSS**

`blocked.css` has 16 color literals because the page is deliberately theme-exempt and always dark. Move them onto the theme-invariant `--focus-*` tokens in `theme.css` (add any missing ones, e.g. `--focus-bg: #0e0c0b; --focus-text: #ece4d8; --focus-text-secondary: #a89c8f; --focus-accent: #e3906e;` to `:root`, which the token-parity test ignores because of the `--focus-` prefix). Then:

```css
.blocked {
  min-height: 100vh;
  align-content: center;
  background: var(--focus-bg);
  color: var(--focus-text);
}
.blocked-inner {
  grid-column: 4 / span 6;
  text-align: center;
}
.blocked h1 {
  font-family: var(--font-display);
  font-size: var(--text-2xl);
  line-height: var(--leading-2xl);
}
@media (max-width: 720px) {
  .blocked-inner {
    grid-column: 1 / -1;
  }
}
```

Delete `blocked.css` from `PENDING`; fix remaining violations with the Task 4 Step 2 rules.

- [ ] **Step 3: Verify and commit**

Run: `npm run typecheck && npx vitest run`; screenshot `blocked/index.html` with and without an active focus session (start one by writing `focusSession: { startedAt: Date.now(), phaseEndsAt: Date.now() + 3e6, focusMinutes: 50 }` to storage).

```bash
git commit -m "Blocked page in warm ink on the grid

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/pages/blocked src/shared/theme.css src/shared/designSystem.test.ts
```

---

### Task 14: Close the migration, full verification

**Files:**
- Modify: `src/shared/designSystem.test.ts` (delete `PENDING`)
- Modify: `.claude/skills/verify/SKILL.md` (new selectors)

- [ ] **Step 1: Remove the pending mechanism**

Delete the `PENDING` set, the `'lists only real files as pending'` test, and the `.filter((f) => !PENDING.has(f))` in the sweep, so every stylesheet is always checked.

Run: `npx vitest run src/shared/designSystem.test.ts`
Expected: PASS with one sweep case per CSS file (10).

- [ ] **Step 2: Update the verify skill**

In `.claude/skills/verify/SKILL.md` "Flows worth driving": replace the `.relay-hero`/`.relay-commands`/`.relay-focus-row` lines with: the page is `.edition`, the masthead `.edition-masthead`, the lead story `.edition-lead`, stories carry `[data-story]`, focus controls live in `.edition-actions`; the reader root carries `data-chrome="awake|asleep"`, status lives in `.reader-capsule`, the outline rail is `.reader-rail`, the focus line sets `[data-focus-line]`. Add: "seed `settings.skin` with an old value to check retired fields stay inert."

- [ ] **Step 3: Full verification pass**

Run `/verify`. Seed: two articles and one paper with `pdf` progress in `readingProgress`/`papers`, three `cachedItems`, a bookmark, `settings: { …, displayName: 'Aakash', skin: 'alert' }`. Visit newtab, reader (`?src=` arXiv PDF and `?article=` Wikipedia), papers, options, blocked; light and dark; 1440 and 800 wide. Read every screenshot. Collect console and page errors.
Expected: zero errors; masthead/lead/sidebar share column lines; reader chrome sleeps and wakes; no orange viewport ring; no skin anywhere.

- [ ] **Step 4: Full checks**

Run: `npm run typecheck && npm test && npm run build > /tmp/build.log 2>&1; echo $?`
Expected: all green, exit 0.

- [ ] **Step 5: Commit**

```bash
git commit -m "Hold every stylesheet to the design system

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/shared/designSystem.test.ts .claude/skills/verify/SKILL.md
```
