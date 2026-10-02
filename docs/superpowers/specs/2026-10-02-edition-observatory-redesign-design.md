# Edition + Observatory redesign

Date: 2026-10-02 · Branch: `strip-notion-redundancy` · Status: approved in brainstorming, awaiting spec review

## Intent

Two outcomes, in the user's words:

1. The new tab is a page you *want* to open to start the day.
2. As a researcher, you can read a paper in the reader without drifting off.

Influences: Apple, Tesla, Figma, Anthropic, OpenAI, Google, Nick Babich's UI/UX principles (one primary action per screen, progressive disclosure, visible system status, recognition over recall).

Chosen direction (from visual mockups): **B "Morning Edition"** for the new tab (warm paper and ink, serif headlines, a front page), **A "Observatory"** for the reader (chrome that disappears, a glowing progress line, a floating status capsule), unified by a **Clay** accent.

## Constraints carried forward

- Low-vision rules from phase 20: Atkinson Hyperlegible for body text, weights 400/700 only, no pure white on dark, 12px text floor, `--text-faint` is decorative only.
- No emojis anywhere in UI copy.
- `prefers-reduced-motion` and `prefers-reduced-transparency` fallbacks stay.
- Settings are read through `useSettings()`, never `useStorageValue('settings')`.
- No new runtime dependencies. No new storage keys except one settings field (`readerFocusLine`), which needs no migration (settings merge with `DEFAULT_SETTINGS`).
- Scope is every page: new tab, reader (article + PDF), Papers, Options, Blocked.

## 1. Design system (`src/shared/theme.css`)

### Palette

Token **names** stay; **values** change, so every page inherits the palette.

| Token | Light | Dark |
|---|---|---|
| `--bg-page` | `#f5f0e6` paper | `#0e0c0b` |
| `--bg-surface` | `#fbf8f2` | `#191512` |
| `--bg-subtle` | `#ece5d7` | `#221d1a` |
| `--bg-hover` | `#e4dccd` | `#2c2622` |
| `--text-primary` | `#2b2520` ink | `#ece4d8` |
| `--text-secondary` / `--text-muted` | `#6b6158` family | `#a89c8f` family |
| `--border` / `--border-subtle` | `#d9cfbf` / `#e4dccd` | `#3a332d` / `#2c2622` |
| `--accent` | `#c96442` clay | `#e3906e` |
| `--accent-text`, `--accent-hover` | `#a8502f` (4.5:1 on surface) | lighter clay |

Exact secondary values are tuned so the contrast tests in section 5 pass. Heat ramp, glass and `--shadow-accent` tokens are retinted warm. `--focus-*` (immersive palette) is untouched.

### Type

- `--font-sans`: Atkinson Hyperlegible (unchanged).
- New `--font-display: ui-serif, 'New York', 'Iowan Old Style', Georgia, serif` for mastheads, headlines, reader headings. System fonts only; nothing bundled.
- Scale with paired leading on a 4px baseline: `--text-xs` 12/16, `--text-sm` 14/20, `--text-md` 16/24, `--text-lg` 20/28, `--text-xl` 24/32, `--text-2xl` 32/40, `--text-3xl` 40/48. Each size has a matching `--leading-*` token. The current 11px and 13px steps disappear. Because names like `--text-sm` change value (12 → 14), every existing `--text-*` usage is remapped explicitly during the page passes rather than left to inherit the new value.

### Grid coordinate system

- Base unit `--u: 4px`; spacing `--space-1..8` = 4, 8, 12, 16, 24, 32, 48, 64.
- 12-column layout: `--grid-cols: 12`, `--grid-gutter: 24px`, `--grid-margin: 32px` (16px under 720px), `--grid-max: 1200px`.
- A shared `.grid` class in `theme.css`: `display: grid; grid-template-columns: repeat(var(--grid-cols), minmax(0, 1fr)); column-gap: var(--grid-gutter); max-width: var(--grid-max); margin-inline: auto; padding-inline: var(--grid-margin)`. Every page's top-level layout uses it and places blocks with `grid-column` spans.
- `--radius-*` values become multiples of 4.

### Skins retired

Delete `SkinSetting`, the `skin` settings field, `applySkin`/`resolveSkin`/`storedSkin` and the `skinMode` mirror in `theme.ts`, every `[data-skin]` block in `theme.css`, the Accent picker in Options, and skin cases in `theme.test.ts`. A stored `skin` value is ignored; no migration.

## 2. New tab: "The Edition" (`src/pages/newtab/`)

All on `.grid`:

1. **Masthead** (cols 1–12): left date; center edition name (serif, `--text-3xl`) from `editionName(hour)` → "The Morning / Afternoon / Evening Edition", "The Late Edition" before 5am; right time + weather. Double rule beneath, then a dek strip: greeting ("Good morning, Aakash.") left, status ("2 unfinished · 6 new in your feeds") right. The edition name is the page's only `h1`. `Hero.tsx` becomes the masthead (Clock and Weather reused).
2. **Now watching** (cols 1–12, only while a video plays): existing `NowWatching`, styled as a "Live" box.
3. **Lead story** (cols 1–8): newest `resumableItems` entry. Kicker ("Continue reading · paper|article|video"), serif headline, honest status line ("Page 4 of 15" for papers from `paper.pdf`, "42% read · opened 1h ago" for articles, watch time for videos), clay progress bar, one primary ink button "Pick it back up" (Enter). Below: "Also unfinished", the remaining items as `ContinueRow`s restyled as headline rows, recap disclosure intact, 6 visible + "Show all".
4. **Sidebar** (cols 9–12): "From your feeds", `TriageCard`'s picks as headline stories with their reason line; the quote of the day at the bottom in italic serif.
5. **Index row** (cols 1–12, double rule above): Favorites from `BookmarksPanel` as a text row (add/edit/remove intact); right side Papers, Settings, "Start N-minute focus" (or countdown + Stop while focus runs, as today).

- **Empty state**: lead area shows "Nothing open. Press ⌘/Ctrl+Shift+E on any page to read it here." as a front-page notice.
- **Interaction**: staggered fade-up of masthead, lead, sidebar over 300ms on load (none under reduced motion). Headlines underline in clay on hover; whole row is the target. `J`/`K` move a selection across stories; Enter opens it. Keys are ignored while focus is in an input.
- **Under 900px**: sidebar stacks below the lead; all blocks span 1–12.

## 3. Reader: "Observatory" (`src/pages/reader/`)

### Auto-hiding chrome
`ReaderToolbar` keeps all controls, becomes a translucent bar that hides after 2.5s of reading activity. It shows when the pointer is in the top 48px, on scroll-up, when it contains focus, or while any panel is open. Never hides under reduced motion.

### Status
- **Progress line**: 2px clay line fixed at the top edge (glow in dark), width = document progress.
- **Capsule** (bottom-center, replaces the toolbar's center group): "p. 4 of 15 · about 11 min left" (PDF) / "38% · about 6 min left" (article). Minutes = words after the current position in `pageTexts`/`blocks` ÷ 230 wpm, via `minutesLeft()`. Click expands in place to page jump, prev/next, zoom; Escape collapses.
- **Tracking**: `TrackPrompt`'s banner becomes a "Not tracked · Track" chip in the capsule; clicking opens the existing form as a popover.
- **Notices**: scanned-PDF notice and note-mode banner become toasts above the capsule.

### Outline rail
`OutlineSidebar` remains the full panel. When it is closed, a left-edge rail shows one tick per top-level outline entry, current one lit; hover expands labels; click jumps. No outline, no rail.

### Reading aids
- **Focus line** (`F`, persisted as `settings.readerFocusLine`, default off): articles dim all blocks but the current to 40% opacity; PDFs get a `pointer-events: none` overlay that dims above and below a soft band at reading height.
- **Drift nudge**: pure `driftNudge()` decides; the capsule pulses once and reads "You were at {section or page} · Back" after 3 minutes with no scroll/key/pointer activity while visible, or on return after >2 minutes hidden. Back restores the position captured when the drift began. Auto-dismiss after 10s. No sound, no popup.
- **Section finish**: when `sectionAt()` crosses into the next section, the finished tick fills and the capsule shows "Section 3 done · 2 left" for 3s. Requires an outline.

### Look
Dark: pages on `#0e0c0b`; `readerNight` still inverts PDF pages. Light: paper on paper. Articles: 16/28, measure capped at 68ch, serif headings. Notes/Ask/Find panels slide over the page as glass sheets instead of resizing it. The viewport no longer draws the global `:focus-visible` ring on programmatic focus.

## 4. Papers, Options, Blocked

- **Papers ("The Library")**: masthead header (back link, serif "Papers", theme toggle) with the double rule. Desktop: decks cols 1–4, open deck's papers cols 5–12. Paper rows: serif title, muted authors · venue · year, clay progress bar with "Page N of M", status chip. Inline empty state; primary ink "Add deck". RecallSearch as a strip above the papers column.
- **Options ("Colophon")**: sticky scroll-spy section index cols 1–3; settings cols 4–10 as ruled rows (label left, control right, hairlines) instead of cards. Accent picker removed; Reader section gains the Focus line toggle. Primary buttons ink-filled. Text inputs keep commit-on-blur.
- **Blocked**: warm dark (`#0e0c0b`), serif headline, cols 4–9, copy and actions unchanged.

## 5. Consistency tests and CI

### `src/shared/designSystem.test.ts` (vitest, reads every `.css` under `src/`)
1. No `#hex`, `rgb()`, `hsl()` or named colors outside `theme.css`. Escape hatch: `/* ds-exempt: reason */` on the same line; the test also caps the total exemptions so they stay rare.
2. `margin*`, `padding*`, `gap`/`row-gap`/`column-gap`, `inset*`, `top/right/bottom/left`, and px inside `grid-template-*` are a `--space-*`/`--grid-*` token, `0`, `auto`, a percentage, or a multiple of 4px.
3. `font-size` is a `--text-*` token; `line-height` is a `--leading-*` token; `font-weight` ∈ {400, 700, normal, bold}.
4. `border-radius` is a `--radius-*` token or `50%`.

Failures report file:line and the offending value.

### `src/shared/theme.test.ts` (rewritten)
- Light/dark token parity: same token set in both blocks.
- Every `--space-*`, `--radius-*`, `--leading-*` is a multiple of 4.
- Contrast computed from `theme.css` hex values, both themes: ≥ 4.5:1 for `--text-primary/secondary/muted` on `--bg-page`/`--bg-surface`, `--on-accent` on `--accent`, `--accent-text` on `--bg-surface`; ≥ 3:1 for `--accent` on `--bg-page` (UI).
- No `data-skin` anywhere.

### Logic unit tests (test first, pure modules in `src/shared/`)
`editionName(hour)`, `minutesLeft(texts, position)`, `driftNudge(state)`, `sectionAt(position, outline)` + crossing detection.

### `.github/workflows/ci.yml`
On push and pull_request: ubuntu-latest, Node 22, `npm ci` → `npm run typecheck` → `npm test` → `npm run build`.

### Local verification before done
The repo's `/verify` Playwright pass over every page in light and dark: screenshots reviewed, zero console errors. Not part of CI (static rules only, by choice).

## Out of scope

Screenshot-diff and measured-geometry tests in CI; new data sources; bundling a serif webfont; changes to background/worker logic beyond the one settings field.
