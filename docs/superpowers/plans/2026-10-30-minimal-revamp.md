# Minimal Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete every feature off the keep list, then rebuild the new tab as the Now / Read split and quiet every other page to the same restraint.

**Architecture:** Subtraction first, one feature per task. Each task removes the code, settings, storage, options UI and tests of one cut feature, and adds its dead keys to the cumulative sweep in `src/shared/storage.ts`. It also adds its identifiers to a "cut stays cut" guard test, so the regression net grows task by task. After the cuts, one task adds the deck selector and one rewrites the new tab. The last pass is CSS-only on the other pages, guarded by two new lint rules.

**Tech Stack:** TypeScript, React 18, Vite + CRXJS (MV3), vitest (unit), vitest + Playwright (`e2e/`, against `dist/` built with `npm run build:e2e`).

**Spec:** `docs/superpowers/specs/2026-10-29-minimal-revamp-design.md`

## Global Constraints

- Start from commit `0c70025` on a new branch `minimal-revamp` cut from `second-brain`. Leave the unrelated `CLAUDE.md` working-tree deletion alone and never stage it.
- Read settings with `useSettings()`, never `useStorageValue('settings')`.
- Never animate the display serif's `font-weight`.
- New CSS uses tokens only. `src/shared/designSystem.test.ts` must pass.
- Kept data must not change shape. The one exception: `nudge` is dropped from progress records and papers.
- Pomodoro site blocking, the clock-in intention and the blocked-page quote keep working.
- News keeps the embedding shortlist and the Laya rerank, and stays hidden during a focus round.
- Settings that stay: `mutedTopics`, `semanticScholarApiKey`, `readerNight`, `readerFocusLine`, `theme` (paperwhite included), `notificationsEnabled`.
- No animation except the clock ticking and the existing spring tokens on direct interaction.
- No cards-in-cards or boxed panels. Sections are separated by space and one hairline.

## The per-task test gate (the user's requirement: continuous unit, regression and edge-case tests)

Every task ends with all of these, in order, before its commit:

1. **Unit:** the task's new or changed `*.test.ts` files: `npx vitest run <files>`, expected PASS.
2. **Edge cases:** the edge-case tests named in that task (they live in the same files as the unit tests).
3. **Regression:** `npm run -s typecheck && npm test`. Expected: `ok`, and every test file passes. The total count only moves by the tests the task added or deliberately deleted. Report the before/after count in the commit body.
4. **Guard:** `npx vitest run src/shared/cutFeatures.test.ts src/shared/storage.test.ts src/shared/designSystem.test.ts`, expected PASS. This already runs as part of step 3; it is listed so a failure is read as a regression, not a flake.
5. **E2E (UI-touching tasks only, marked E2E below):** `npm run -s build:e2e && npx vitest run --config vitest.e2e.config.ts <specs>`, expected PASS with zero console errors.

## Review Focus

1. **Profile upgraded from v24 with every cut feature in use.** Bookmarks, weather cache, aiStats, nudge state on progress and papers, retired alarms and the old context-menu item are all present. Expected: one `migrate()` leaves only kept keys, Continue still lists every item, and no error is thrown. Test: Task 7, `v25 sweep on a full legacy profile`.
2. **The migration re-runs.** `migrate()` runs on every startup and the sweep is cumulative. Running it twice must equal running it once. Test: Task 7, `migrate is idempotent`.
3. **A focus session already running at upgrade.** A `focusSession` with an `intention`, plus a stale `driftChecked` session key. Expected: the blocking rules stay, the blocked page still quotes the intention, and nothing throws. Test: Task 5, `focus survives drift removal`.
4. **Empty and huge lists on the new tab.** No progress, no feeds, no provocations; and 60 of each. Expected: one-line hints or nothing, at most 5 rows plus "Show all N", and no inner scrollbar. Test: Task 9 e2e, `empty profile` and `crowded profile`.
5. **Narrow window and dark theme.** At 600px the columns stack (Now first) with no horizontal overflow. Dark theme passes a11y. Test: Task 9 e2e, `stacks under 720px` and the existing smoke a11y loop in light and dark.

---

### Task 1: Branch and guard rails

**Files:**
- Create: `src/shared/cutFeatures.test.ts`
- Modify: `src/shared/storage.test.ts` (append one `describe`)

**Interfaces:**
- Produces: `CUT` array in `cutFeatures.test.ts`. Later tasks append identifier strings to it. Each entry is `{ name: string; pattern: RegExp }`.
- Produces: `KEPT_LOCAL_KEYS` in `storage.test.ts`. Later tasks must never remove an entry.

- [ ] **Step 1:** `git switch -c minimal-revamp`, then `npm test 2>&1 | tail -4` and note the baseline count (expected 1084).
- [ ] **Step 2: Write the guard test** `src/shared/cutFeatures.test.ts`:
  - It walks `src/`, `e2e/` and `mcp/` (`readdirSync` recursively, `.ts`/`.tsx`/`.css`).
  - It skips `src/shared/storage.ts`, `src/background/alarms.ts` and itself, because those name dead keys on purpose.
  - For each `CUT` entry: `it(\`${name} stays cut\`, () => expect(hits(pattern)).toEqual([]))`, where `hits` returns `file:line` strings.
  - It starts with `const CUT = [] as { name: string; pattern: RegExp }[];` and `it('has entries once the cuts start', ...)` wrapped in `it.skipIf(CUT.length === 0)`, so it is green today.
- [ ] **Step 3: Write the data-safety regression** in `storage.test.ts`:

```ts
const KEPT_LOCAL_KEYS = ['schemaVersion','provocations','feeds','readItems','cachedItems','cacheTimestamp','settings',
  'readingProgress','focusSession','decks','papers','annotations','aiCache','aiVectors','layaRoles','activity',
  'dumps','vault','lockedDumps'] as const;
describe('kept data', () => {
  it('every kept key still has a default', () => { for (const k of KEPT_LOCAL_KEYS) expect(DEFAULTS).toHaveProperty(k); });
  it('no kept key is ever swept', () => { for (const k of KEPT_LOCAL_KEYS) expect(V22_DEAD_KEYS).not.toContain(k); });
  it('no live setting is ever swept', () => { for (const k of Object.keys(DEFAULT_SETTINGS)) expect(V22_DEAD_SETTINGS).not.toContain(k); });
  it('no live local key is ever swept', () => { for (const k of Object.keys(DEFAULTS)) expect(V22_DEAD_KEYS).not.toContain(k); });
});
```

- [ ] **Step 4:** Run the gate (1–4). Expected: PASS, count = baseline + 5.
- [ ] **Step 5:** Commit `Guard rails for the minimal revamp: cut-stays-cut and kept-data tests`.

---

### Task 2: Cut the masthead (hero, weather, quote, greeting, obstacle course, ambient motion) — E2E

**Files:**
- Delete: `src/pages/newtab/Hero.tsx`, `Hero.test.ts`, `Weather.tsx`, `Weather.test.ts`, `quotes.ts`, `ObstacleCourse.tsx`, `ObstacleCourse.test.ts`, `src/shared/hooks/useAmbient.ts`, `src/shared/ambient.test.ts` (and `src/shared/ambient.ts` if present)
- Delete: `src/pages/options/NewTabSection.tsx`. Move its `MutedTopicsRow` into a new file `src/pages/options/MutedTopicsRow.tsx`, rendered inside the existing "Your Feeds" section of `Options.tsx`.
- Modify: `Dashboard.tsx` (drop `<Hero>`, `quote`, `status`), `src/shared/types.ts` (remove `displayName`, `weatherLocation`, `ambientMotion`, `WeatherCache`), `src/shared/storage.ts` (defaults, the `weather` key), `src/shared/hooks/useSettings.ts`, `newtab.css` (remove `.edition-masthead*`, `.edition-quote`, obstacle-course rules), `SectionIndex.tsx` (drop the New Tab entry)
- Modify: `e2e/smoke.e2e.ts`, `e2e/load.e2e.ts` and the verify skill's selectors wherever they wait on `.edition-masthead`. Wait on `.edition` instead.

**Interfaces:**
- Produces: `MutedTopicsRow({ value }: { value: string[] })` in `src/pages/options/MutedTopicsRow.tsx`, the same component moved as-is.

- [ ] **Step 1: Failing guard.** Append to `CUT`: `Hero` `/\bHero\b|edition-masthead/`, `weather` `/weatherLocation|WeatherCache|\bWeather\b/`, `greeting` `/displayName/`, `ambient` `/ambientMotion|useAmbient|ObstacleCourse/`, `quote` `/quoteOfDay/`.
- [ ] **Step 2:** `npx vitest run src/shared/cutFeatures.test.ts`. Expected: FAIL, listing hits.
- [ ] **Step 3: Failing sweep test** in `storage.test.ts`: `V22_DEAD_KEYS` contains `'weather'`; `V22_DEAD_SETTINGS` contains `'displayName'`, `'weatherLocation'`, `'ambientMotion'`; `v22StripSettings({ displayName: 'A', weatherLocation: 'X', ambientMotion: true, mutedTopics: ['x'] })` equals `{ mutedTopics: ['x'] }`.
- [ ] **Step 4:** Delete the files and references listed above. Add the keys to `V22_DEAD_KEYS` / `V22_DEAD_SETTINGS` under a `// v25: minimal revamp` comment.
- [ ] **Step 5: Edge case** in `storage.test.ts`: `v22StripSettings` on `undefined`, `null` and `'string'` returns `null`, and on `{}` returns `{}`. Add only the ones not already covered.
- [ ] **Step 6:** Gate 1–5. E2E specs: `smoke`, `load`, `mutedTopics`. Expected: PASS; muted topics still saves and still hides matching feed items.
- [ ] **Step 7:** Commit `Cut the masthead: hero, weather, quote, greeting, obstacle course`.

---

### Task 3: Cut Now Watching, keep one clock — E2E

**Files:**
- Delete: `src/pages/newtab/NowWatching.tsx` and its CSS in `newtab.css`
- Modify: `src/shared/hooks/useNowWatching.ts`, renamed to `src/shared/hooks/useWatchClock.ts`
- Modify: `Dashboard.tsx`
- Delete: `SessionSchema.videoTranscripts` and its writers, if no file outside the Follow pane reads it (`git grep videoTranscripts`). Otherwise keep it and note why in the commit.
- Test: `src/shared/hooks/useWatchClock.test.ts` (pure helper only)

**Interfaces:**
- Produces: `useWatchClock(): number`, the current ms. It ticks every 500 ms while `currentlyWatching(readingProgress, now) !== null` and stands still otherwise.
- Produces: `watchTickMs(watching: boolean): number | null`, which returns 500 or null. It is pure, so it can be tested.

- [ ] **Step 1: Failing guard.** Add to `CUT`: `now-watching` `/NowWatching|useNowWatching/`.
- [ ] **Step 2: Failing unit test:** `watchTickMs(true) === 500`, `watchTickMs(false) === null`.
- [ ] **Step 3:** Implement and wire the hook: `ContinueRow` gets `now={useWatchClock()}`. Delete the card.
- [ ] **Step 4: Edge case:** in `src/shared/youtube.test.ts`, a progress entry with `playing: true` and a stale `updatedAt` makes `currentlyWatching(...) === null`. That means no tick and no "Watching ·" label. Add it only if the existing tests don't already cover it.
- [ ] **Step 5:** Gate 1–5. E2E spec: `continue`. Expected: a seeded playing video shows "Watching · m:ss" on its Continue row, and no `.now-watching` element exists.
- [ ] **Step 6:** Commit `Cut Now Watching; Continue rows keep a single watch clock`.

---

### Task 4: Cut bookmarks and favorites — E2E

**Files:**
- Delete: `src/background/bookmarks.ts`, `src/pages/newtab/BookmarksPanel.tsx`, `BookmarksPanel.test.ts`, `src/shared/hooks/useBookmarks.ts`
- Modify: `src/background/router.ts` (5 `*_BOOKMARK*` cases), `src/shared/messages.ts` (their request/response types), `src/background/index.ts` (the `bookmark-link` menu item and its click branch), `src/shared/constants.ts` (`MAX_BOOKMARKS`, `NOTIFICATION_IDS.bookmarkSaved`), `src/shared/types.ts` (`BookmarkGroup`, `BookmarkLink`), `src/shared/storage.ts` (keys and defaults; `migrateToV6` iterates only `['decks']`), `src/background/tracking.ts` (`isKnownUrl` drops the `bookmarks` source), `src/pages/newtab/EditionIndex.tsx` (Papers and Settings only)

**Interfaces:**
- Modifies: the `isKnownUrl` known-list type in `tracking.ts` becomes `{ cachedItems: FeedItem[]; readingProgress: Record<string, AnyProgress> }`.

- [ ] **Step 1: Failing guard.** Add to `CUT`: `bookmarks` `/BOOKMARK|Bookmark(Link|Group|sPanel)|useBookmarks|bookmark-link/`.
- [ ] **Step 2: Failing sweep test:** `V22_DEAD_KEYS` contains `'bookmarks'` and `'bookmarkGroups'`.
- [ ] **Step 3:** Delete and modify as listed.
- [ ] **Step 4: Regression** in `src/background/tracking.test.ts`: a URL in `cachedItems` is still known; a URL with existing `readingProgress` is still known; an unrelated URL is not known. Update the existing test fixtures that passed `bookmarks`.
- [ ] **Step 5: Edge case:** an upgraded profile still has the old "Bookmark this page" item. `index.ts` already calls `contextMenus.removeAll()` before creating menus, so no new code is needed. Confirm that call still runs before `create('read-in-reader')`, and keep it in that position.
- [ ] **Step 6:** Gate 1–5. E2E: `smoke`. Expected: `.edition-index` shows exactly Papers and Settings.
- [ ] **Step 7:** Commit `Cut bookmarks and favorites`.

---

### Task 5: Cut drift nudges and the hyperfocus guardrail

**Files:**
- Delete: `src/background/drift.ts`, `drift.test.ts`, `src/background/hyperfocus.ts`, `src/pages/reader/useDriftNudge.ts`
- Modify: `src/background/index.ts` (the `checkDrift` call), `src/pages/reader/Reader.tsx` (the hook use and its message element), `src/background/tracking.ts`, `videoTracking.ts` and `papers.ts` (`recordEngagement` calls), `src/shared/constants.ts` (`HYPERFOCUS_MINUTES`, `LAYA_DRIFT_MIN`, `NOTIFICATION_IDS.hyperfocus`, `NOTIFICATION_IDS.focusDrift`), `src/shared/types.ts` (`hyperfocusEnabled`; the `FocusSession.intention` comment now reads "the blocked page quotes it"), `src/shared/storage.ts` (`SessionSchema.hyperfocus`, `SessionSchema.driftChecked` and their defaults), `src/pages/options/Options.tsx` (the `hyperfocus-enabled` row), `src/shared/messages.ts` (the hyperfocus comment on the delta field; the field stays if `activity` or progress still uses it)

- [ ] **Step 1: Failing guard.** Add to `CUT`: `drift` `/checkDrift|useDriftNudge|driftChecked|LAYA_DRIFT_MIN|focusDrift/`, `hyperfocus` `/hyperfocus|HYPERFOCUS/i`.
- [ ] **Step 2: Failing sweep test:** `V22_DEAD_SETTINGS` contains `'hyperfocusEnabled'`. Session storage is cleared on browser restart, so it needs no sweep. Still, `migrate()` calls `chrome.storage.session.remove(['hyperfocus','driftChecked','lastGlobalNudgeAt'])` unconditionally, because session storage survives an extension update. Removing an absent key is a no-op. Task 7 reuses this call for `lastGlobalNudgeAt`.
- [ ] **Step 3:** Delete and modify as listed.
- [ ] **Step 4: Regression `focus survives drift removal`** in `src/background/focus.test.ts`: starting a session with `intention: 'write ch. 3'` still produces blocking rules for the blocklist (via the existing test seam), and `FocusSession.intention` round-trips. Add an e2e assertion in `e2e/smoke.e2e.ts`: the blocked page, opened as `blocked/index.html#https://x.com/` with a seeded focusing session that has an intention, shows the intention text.
- [ ] **Step 5: Edge case:** `npx vitest run src/background/tracking.test.ts src/background/papers.test.ts`. An engagement delta of 0 and a hidden flush both still update `activeSeconds` correctly, with no hyperfocus call left to swallow them.
- [ ] **Step 6:** Gate 1–5. E2E: `smoke`, `reader`. Expected: the reader shows no drift message, even with `page.clock` advanced 60 s.
- [ ] **Step 7:** Commit `Cut drift nudges and the hyperfocus guardrail; blocking and intention stay`.

---

### Task 6: Cut Flowtunes, Gemini, suggested feeds and AI stats — E2E

**Files:**
- Delete: `src/shared/llm/gemini.ts`, `gemini.test.ts`, `src/pages/options/SuggestedFeeds.tsx`, `SuggestedFeeds.test.ts`, `src/shared/feedDiscovery.ts`, `feedDiscovery.test.ts`, `e2e/suggestions.e2e.ts`
- Modify: `src/background/focus.ts` and `src/shared/constants.ts` (Flowtunes open and pin), `ContinueRow.tsx` (the `settings.geminiKey` branch; the no-transcript path falls through to its existing "can't summarize" state), `LocalAiSection.tsx` (the `gemini-key` row and the whole "What it has done for you" block with `ImpactRows`), `Options.tsx` (the `focus-music` row and the `SuggestedFeeds` mount), `src/shared/llm/store.ts` (delete `recordStat`, `updateStats`, `settleProbes`, `probePercent` and their queue; keep the cache and vectors), `store.test.ts` (delete their tests), every `recordStat` call site (`ContinueRow`, `TriageCard`, `RecallSearch`, `AskSheet`, `RecapCard`, `RelatedHighlight`, `generate.ts`), `Dashboard.tsx` (the settle effect), `types.ts` (`AiStats`, `focusMusicEnabled`, `geminiKey`), `storage.ts`, `e2e/continue.e2e.ts` (the Gemini cases)

- [ ] **Step 1: Failing guard.** Add to `CUT`: `flowtunes` `/focusMusic|flowtunes/i`, `gemini` `/gemini/i`, `suggested-feeds` `/SuggestedFeeds|feedDiscovery/`, `ai-stats` `/recordStat|updateStats|settleProbes|probePercent|aiStats|AiStats|ImpactRows/`.
- [ ] **Step 2: Failing sweep test:** `V22_DEAD_KEYS` contains `'aiStats'`; `V22_DEAD_SETTINGS` contains `'focusMusicEnabled'` and `'geminiKey'`.
- [ ] **Step 3:** Delete and modify as listed. The "Add New Feed by URL" section stays and still works.
- [ ] **Step 4: Regression:** `npx vitest run src/shared/llm`. The cache (`cacheGet`/`cachePut`) and `updateVectors` tests still pass; `generate.ts` still caches.
- [ ] **Step 5: Edge case:** `src/background/focus.test.ts`. Starting a focus session opens no tabs (`chrome.tabs.create` is not called), including when a legacy stored `focusMusicEnabled: true` is present in settings.
- [ ] **Step 6:** Gate 1–5. E2E: `smoke`, `continue`, `triage`. Expected: the options page has no `#gemini-key`, `#focus-music` or "What it has done for you"; triage still ranks.
- [ ] **Step 7:** Commit `Cut Flowtunes, Gemini summaries, suggested feeds and AI stats`.

---

### Task 7: Cut reading nudges and land schema v25

**Files:**
- Delete: `src/background/nudges.ts`, `nudges.test.ts`, and `src/shared/videoCategory.ts` + `videoCategory.test.ts` only if `nudges.ts` and Dashboard's grouping (Task 9 removes it) were the only users. Otherwise leave them for Task 9.
- Modify: `src/background/alarms.ts` (the nudge branch; `clearRetiredAlarms` also clears every alarm whose name starts with `'nudge|'`), `src/background/index.ts` (the notification click/close handlers for `nudgePrefix`, `resumeArticle` if nothing else uses it), `tracking.ts`, `videoTracking.ts`, `papers.ts` (`scheduleNudge`/`cancelNudge` calls, `nudge:` initialisers), `constants.ts` (`NUDGE_*`, `ALARMS.nudgePrefix`, `NOTIFICATION_IDS.nudgePrefix`), `types.ts` (`nudgesEnabled`, `ProgressBase.nudge`, `Paper.nudge`), `storage.ts` (`SessionSchema.lastGlobalNudgeAt`; v25), `Options.tsx` (the `nudges-enabled` row), `e2e/seed.ts` (stop seeding `nudge`), and the verify skill text that says to seed `nudge`

**Interfaces:**
- Produces: `v25StripNudge<T extends object>(record: T): Omit<T, 'nudge'>` and `v25Progress(map: Record<string, unknown> | undefined): Record<string, unknown> | null` in `storage.ts`. The second returns null when nothing changed.

- [ ] **Step 1: Failing guard.** Add to `CUT`: `nudges` `/scheduleNudge|cancelNudge|fireNudge|nudgesEnabled|NUDGE_|nudgePrefix|lastGlobalNudgeAt/`.
- [ ] **Step 2: Failing unit tests** in `storage.test.ts`:
  - `v25Progress({ a: { url:'u', maxPercent: 40, nudge: {count:1,lastAt:2,dismissed:false} } })` equals `{ a: { url:'u', maxPercent: 40 } }`
  - `v25Progress({ a: { url:'u' } })` is `null` (already clean, no write)
  - `v25Progress(undefined)` is `null`
  - the same strip applied to a papers array removes `nudge` and leaves every other field deep-equal
  - `V22_DEAD_SETTINGS` contains `'nudgesEnabled'`
- [ ] **Step 3:** Implement. In `migrate()`, under `if (version < 25)`, strip `readingProgress` and `papers`, then set `schemaVersion: 25`. Update the migration doc comment with a `v24 → v25` line.
- [ ] **Step 4: Review Focus #1 — `v25 sweep on a full legacy profile`.** Add a test with an in-memory `chrome.storage` fake (reuse the one `storage.test.ts` already uses if present; otherwise a 20-line `Map`-backed fake in the test file). Seed a v24 profile with: `bookmarks`, `bookmarkGroups`, `weather`, `aiStats`; settings with every cut field plus `mutedTopics: ['x']`; two progress entries and one paper with `nudge`; plus `dumps`, `vault`, `lockedDumps`, `provocations` and `annotations` set to sentinel values. Run `migrate()`. Then assert:
  - no cut key remains
  - settings keep `mutedTopics`
  - no record has `nudge`
  - every sentinel is deep-equal to what was seeded
  - `schemaVersion === 25`
- [ ] **Step 5: Review Focus #2 — `migrate is idempotent`.** Run `migrate()` a second time and the storage snapshot is deep-equal to the first run.
- [ ] **Step 6: Edge case:** in `src/background/alarms.test.ts` (create it), `clearRetiredAlarms` clears `nudge|abc` and `nudge|paper:1`, and leaves `refresh-feeds` and `focus-phase-end`.
- [ ] **Step 7:** Gate 1–5. E2E: `smoke`, `continue`, `load`. Expected: Continue still lists seeded items, and its X still removes one.
- [ ] **Step 8:** Commit `Cut reading nudges; schema v25 strips nudge state`.

---

### Task 8: Deck open questions selector

**Files:**
- Modify: `src/shared/thinking.ts`
- Test: `src/shared/thinking.test.ts`

**Interfaces:**
- Consumes: `Provocation`, `Paper`, `Annotation` from `src/shared/types.ts`; `readerPageUrl` from `src/shared/pdf.ts`.
- Produces:

```ts
export interface OpenQuestion { id: string; question: string; status: 'open' | 'unsure'; paperTitle: string; href: string; updatedAt: number }
export function openQuestions(papers: readonly Paper[], annotations: readonly Annotation[], provocations: readonly Provocation[]): OpenQuestion[];
```

  It uses the same "open" rule as `paperThinking().open`: status ≠ answered, kind ≠ `'page'`, the paper exists, and a counterpoint's annotation is still alive. It sorts by `updatedAt` descending. `href` is `${readerPageUrl(paper.pdf?.url ?? paper.url)}#page=${p.page}`, or the bare URL when `page <= 0`. That is the link `PaperRecord.tsx` uses; extract it there as `thinkingLink(paper, page)` and use it in both places.

- [ ] **Step 1: Failing tests:**
  - `returns open and unsure, never answered`
  - `skips page-kind provocations` (matches the deck)
  - `skips a counterpoint whose highlight was deleted`
  - `skips provocations whose paper is gone` (edge: deleted paper, `paperId: null`)
  - `newest first by updatedAt`
  - `page 0 links the bare reader URL; page 4 appends #page=4`
  - `agrees with paperThinking().open for the same paper`: a regression that compares id sets
  - `empty inputs give []`
- [ ] **Step 2:** Run them. Expected: FAIL, `openQuestions` is not exported.
- [ ] **Step 3:** Implement. Extract `thinkingLink` and switch `PaperRecord.tsx` to it.
- [ ] **Step 4:** Gate 1–4.
- [ ] **Step 5:** Commit `Deck open questions selector for the new tab`.

---

### Task 9: New tab, layout C (Now / Read) — E2E

**Files:**
- Modify: `src/pages/newtab/Dashboard.tsx` (the layout), `newtab.css` (rewrite down to what layout C uses), `FocusTimer.tsx` (presentation only), `ActivityHeatmap.tsx` (compact; the ramp comes from Clay tokens), `TriageCard.tsx` (presentation: plain rows), `ContinueRow.tsx` (presentation: title left, metadata right)
- Create: `src/pages/newtab/DeckList.tsx`
- Create: `src/pages/newtab/visibleRows.ts` + `visibleRows.test.ts`
- Delete: the lead-story markup, `groupByCategory` use (and `videoCategory.ts` if now unused), `EditionIndex.tsx` if folded in (builder's call per spec)
- Modify: `e2e/smoke.e2e.ts`, `e2e/load.e2e.ts`, `e2e/continue.e2e.ts`, `e2e/triage.e2e.ts`, `e2e/zz-scrollperf.e2e.ts`; create `e2e/newtab.e2e.ts`
- Modify: `.claude/skills/verify/SKILL.md`, the new-tab selector paragraph

**Interfaces:**
- Consumes: `openQuestions()` and `OpenQuestion` (Task 8); `useWatchClock()` (Task 3).
- Produces:
  - `visibleRows<T>(items: readonly T[], expanded: boolean, limit = 5): { shown: T[]; hidden: number }`
  - `DeckList({ items }: { items: OpenQuestion[] })`
  - DOM contract for e2e and verify: `.edition` contains `.now-col` (`.pomo`, the brain dump, the heatmap) and `.read-col` (`section[aria-label="Continue"]`, `section[aria-label="Deck"]`, `section[aria-label="News"]`). Each openable row keeps `[data-story]`. "Show all" is `button.show-all`. The foot is `.edition-index`.

Structure, from the spec:
- **Now column**, about 38% wide: a serif clock with one Clay status line ("focus · sites blocked" / "break" / an idle Start control), then the brain dump, then the heatmap.
- **Read column:** Continue, then Deck, then News. Each has a small uppercase label.
- **Continue** has two sub-lists, "Reading" and "Watching", under one label, with no categories. Each sub-list is capped at 5 by `visibleRows`.
- News is hidden while `focus.focusing`.
- One vertical hairline between the columns. Below 720px the layout is one column, Now first.
- Keys: J/K walk `[data-story]`, Enter opens the selection, C clocks in. All unchanged.

- [ ] **Step 1: Failing unit tests** in `visibleRows.test.ts`:
  - 3 items: shows 3, hidden 0
  - 7 items: shows 5, hidden 2
  - 7 items expanded: shows 7, hidden 0
  - 0 items: `{ shown: [], hidden: 0 }`
  - `limit` 0 shows none and hides all (edge)
- [ ] **Step 2:** Implement `visibleRows`, then rewrite `Dashboard.tsx` and `newtab.css` to the structure above. Add `DeckList`.
- [ ] **Step 3: Failing e2e** `e2e/newtab.e2e.ts`, using `launch`/`seed`/`expectClean`/`expectA11y`/`horizontalOverflow` from `e2e/harness.ts`:
  - `two columns`: `.now-col` and `.read-col` are side by side at 1280px (the now column's `getBoundingClientRect().right` ≤ the read column's `.left`).
  - `stacks under 720px`: at 600px wide, the read column's top ≥ the now column's bottom, and `horizontalOverflow(page)` is false. (Review Focus #5)
  - `empty profile`: no progress, feeds or provocations. There are no empty `section`s with zero rows and no hint, and zero console errors. (Review Focus #4)
  - `crowded profile`: 60 progress items, 60 feed items and 60 open provocations. Each sub-list shows at most 5 `[data-story]` rows; "Show all N" shows the right N and expands; no element inside `.read-col` has `scrollHeight > clientHeight` with `overflow` auto/scroll. (Review Focus #4)
  - `news hidden during focus`: seed a focusing `focusSession`, and `section[aria-label="News"]` is absent.
  - `deck row opens the reader at its page`: click the first Deck row. The URL ends with `#page=<n>`.
  - `keyboard`: J moves focus to the second `[data-story]`, and Enter navigates.
  - `no motion`: with `ambient`/`obstacle` gone, `document.getAnimations()` filtered to non-clock targets is empty after 2 s idle.
- [ ] **Step 4:** Update the other e2e specs to the new DOM contract (no `.edition-lead`; the lead tests become "first Continue row").
- [ ] **Step 5:** Gate 1–5. E2E: `newtab`, `smoke`, `load`, `continue`, `triage`, `thinking`, `zz-scrollperf`. Expected: PASS, a11y clean in light and dark.
- [ ] **Step 6:** Look at the screenshots `smoke-newtab*.png` in light, dark and 600px against mockup C (`.superpowers/brainstorm/3794-1793340541/content/newtab-directions.html`). Fix anything boxed, nested or animated.
- [ ] **Step 7:** Commit `New tab: Now / Read split (layout C)`.

---

### Task 10: The same restraint on every other page — E2E

**Files:**
- Modify (CSS and presentational JSX only): `src/pages/reader/reader.css`, `src/pages/papers/papers.css`, `src/pages/options/options.css`, `src/pages/dumps/dumps.css`, `src/pages/blocked/blocked.css`, `src/pages/define/define.css`, `src/shared/components/*.css`
- Modify: `src/shared/designSystem.test.ts` (two rules)
- Modify: `src/shared/motion.test.ts` if a removed animation was pinned there

**Interfaces:**
- Produces: two lint rules in `lintCss`, `rule: 'gradient'` and `rule: 'shadow'`.

- [ ] **Step 1: Failing lint tests** in `designSystem.test.ts`:
  - `lintCss('a{background:linear-gradient(red,blue)}', 'x.css')` reports `gradient` (also `radial-gradient`, `conic-gradient`)
  - `lintCss('a{box-shadow:0 1px 2px var(--c)}', 'x.css')` reports `shadow`
  - `box-shadow: var(--shadow-1)`, `box-shadow: none` and `box-shadow: 0 0 0 2px var(--focus-ring)` (focus rings are allowed) report nothing. Use whatever elevation and focus-ring token names `theme.css` actually defines, and list them in the rule.
  - `theme.css` itself is exempt, as with the existing rules
  - the existing "repo has no violations" test now runs the new rules too, and FAILS on today's CSS
- [ ] **Step 2:** Strip the violations page by page: gradients, ad-hoc shadows, borders around every section (replace with spacing plus one hairline token), decorative ornaments. Clay goes only on state and primary actions. The reader's text column and the metacognition margin card keep their behaviour, and only their chrome gets quieter. `ds-exempt` stays under `MAX_EXEMPTIONS = 12`.
- [ ] **Step 3: Regression:** `npx vitest run src/shared/designSystem.test.ts src/shared/motion.test.ts src/shared/theme.test.ts`. Expected: PASS.
- [ ] **Step 4:** Gate 1–5. E2E: `smoke`, `reader`, `thinking`. Expected: PASS, a11y clean light and dark, and the screenshots for every page reviewed.
- [ ] **Step 5:** Commit `Quiet every page: no gradients, one elevation, hairlines over boxes`.

---

### Task 11: Final sweep and verification

**Files:**
- Modify: `src/shared/types.ts`, `constants.ts`, `messages.ts` (delete anything now unreferenced)
- Modify: `.claude/skills/verify/SKILL.md` (remove the Now Watching, masthead, Gemini and recordings paragraphs)

- [ ] **Step 1:** Run `npx tsc --noEmit --noUnusedLocals --noUnusedParameters 2>&1 | head -50` and `git grep -n "export " src/shared/constants.ts`. Delete exports that no file imports anymore (check each with `git grep -l <name>`).
- [ ] **Step 2:** Rebuild and look for leftover cut CSS: `git grep -n "masthead\|now-watching\|bookmark\|obstacle\|weather" -- '*.css'`. Expected: empty.
- [ ] **Step 3:** Full gate: `npm run -s typecheck && npm test && npm run -s build && npm run -s build:e2e && npm run -s test:e2e`. Expected: everything passes, with a reported test count.
- [ ] **Step 4:** Run `/verify`: open newtab, options, papers, reader (article and PDF), dumps and blocked. Zero console errors, apart from the documented Ollama-off noise.
- [ ] **Step 5:** Commit `Sweep leftovers; verify skill matches the new tab`.
