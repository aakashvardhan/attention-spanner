# Minimal revamp: keep what gets used, one quiet layout

Date: 2026-10-29. Branch at time of writing: `second-brain`.

## Why

The extension grew by accretion. In a real week the user touches six things: the
research deck, RSS news, the "where I left off" row for videos and pages, brain
dump, the Pomodoro, and the activity heatmap (plus the reader, which the deck
lives in). Everything else is noise on the screen and code to maintain. The goal
is a first-principles cut: delete what is not used, then give what is left one
minimal, simple layout borrowing Figma's structure (clear columns, hairline
dividers, tight labels) and Anthropic's warmth (cream paper, serif accent, Clay
orange used sparingly).

## Goals

- Delete every feature not on the keep list, including its code, settings,
  storage, options UI, tests and e2e specs.
- Rebuild the new tab as layout C, "Now / Read split", the mockup the user picked
  (`.superpowers/brainstorm/3794-1793340541/content/newtab-directions.html`, card C).
- Give the reader, papers, options, dumps and blocked pages the same stripped-down
  treatment: same tokens, same restraint, nothing decorative.
- Features follow the UI. If a kept feature has no place in layout C, it gets one
  there or it is questioned, not tucked into a corner.

## Non-goals

- New features. This is subtraction and re-skin only.
- Changing how kept features behave (ranking, reframe, encryption, metacognition
  passes, blocking rules). Behaviour stays; presentation changes.
- Replacing the design-token system. Build on the existing Edition tokens in
  `src/shared/theme.css` and the token lint in `src/shared/designSystem.test.ts`.

## Anti-goals (a failure even if it works)

- Any animation beyond the clock ticking and the existing spring tokens on
  direct interaction. No ambient motion.
- Cards-inside-cards or boxed panels. Sections are separated by space and one
  hairline, not borders around everything.
- Losing user data from kept features (progress, papers, decks, provocations,
  annotations, dumps, vault, feeds, activity, focus rules).
- Leaving dead settings, storage keys, messages or CSS behind after the cut.

## Keep list (decided by the user)

| Feature | Where it lives now |
|---|---|
| Research deck + papers | `src/pages/papers/`, `src/background/papers.ts`, `src/background/flashcards.ts` (deck storage; the name is a leftover) |
| Reader + metacognition (passes, pass-3 lock, provocations, thinking-move XP, click-to-define, annotations) | `src/pages/reader/`, `src/pages/define/`, `src/content/define.ts`, `src/background/provocations.ts`, `src/background/annotations.ts`, `src/background/defineScript.ts` |
| RSS with smart ranking | `src/background/feeds.ts`, `rssParser.ts`, `src/pages/newtab/TriageCard.tsx` (embedding shortlist + Laya rerank stays) |
| Continue where you left off (pages + videos) | `ContinueRow.tsx`, `src/background/tracking.ts`, `videoTracking.ts`, `videoContext.ts`, content trackers |
| Brain dump (card, Haiku reframe, encrypted vault, dumps page) | `BrainDump.tsx`, `VaultSetup.tsx`, `src/pages/dumps/`, `src/shared/vault.ts` |
| Pomodoro with site blocking | `FocusTimer.tsx`, `src/background/focus.ts`, `accessRules.ts`, `src/pages/blocked/`, `src/pages/chime/` |
| Activity heatmap | `ActivityHeatmap.tsx`, `src/shared/activity.ts` |

Settings that stay because kept features use them: muted topics, the Semantic
Scholar key, the reader's paperwhite / night / focus-line settings, and the
general notifications toggle (it gates the focus-end notification).

Infrastructure the kept list depends on stays: PDF intercept, LLM routing (Haiku /
Ollama / Laya for deck prefill and triage rerank), theme, storage, messages.

## Cut list (decided by the user)

- **Hero / masthead**: greeting, date, clock, weather, quote. `Hero.tsx`, `Weather.tsx`,
  `quotes.ts`, `WeatherCache` type, `settings.weatherLocation`, the greeting-name setting.
- **Obstacle course** and ambient motion: `ObstacleCourse.tsx`, `useAmbient.ts`,
  `src/shared/ambient*`, `settings.ambientMotion`.
- **Now Watching**: `NowWatching.tsx`, `useNowWatching.ts`. Continue covers the
  in-progress video. Check `isWatchingNow` callers before deleting; keep whatever
  ContinueRow still needs.
- **Bookmarks / Favorites**: `BookmarksPanel.tsx`, `useBookmarks.ts`,
  `src/background/bookmarks.ts`, the context-menu entry, `BookmarkGroup` /
  `BookmarkLink` types and storage, the Favorites link in `EditionIndex.tsx`.
- **Drift nudges** (Laya off-task notifications during focus): `src/background/drift.ts`,
  `src/pages/reader/useDriftNudge.ts`, the drift call in `background/index.ts`.
  Blocking stays.
- **Hyperfocus guardrail**: `src/background/hyperfocus.ts`, `settings.hyperfocusEnabled`.
- **Reading nudges** (tab-switch "pick it back up"): `src/background/nudges.ts`,
  `settings.nudgesEnabled`, the `nudge` field on progress records, related alarms
  and notification ids.
- **Flowtunes focus music** (`settings.focusMusicEnabled` and whatever plays it).
- **Suggested feeds**: `SuggestedFeeds.tsx`, `src/shared/feedDiscovery.ts`,
  `e2e/suggestions.e2e.ts`. Adding a feed by URL stays.
- **Gemini YouTube summaries**: `src/shared/llm/gemini.ts`, `settings.geminiKey`.
- **AI stats** in options.
- Options sections, settings fields, constants, alarms, messages, CSS, unit tests
  and e2e specs that only served the above.

## Storage

Add a migration (v24 → v25) in `src/shared/storage.ts`, following the existing
pattern. It removes the cut keys and the cut settings fields, and strips
`nudge` from progress records. Clear retired alarms through
`clearRetiredAlarms`. Kept data must not change shape, with one exception: the `nudge` field on
progress records belongs to a cut feature, so it is dropped from the type and
the stored records.

## New tab: layout C

Two columns on a warm off-white page, separated by one vertical hairline. No
masthead.

**Left, "Now" (about 38% of the width)**
1. The Pomodoro clock, large, in the display serif. This is the only serif on the page.
   Under it, one status line in Clay: "focus · sites blocked", "break", or a
   Start control when idle. Clock in/out, breaks and chime behave as today.
2. The brain dump box, behaving as today (Cmd+Enter reframe, vault).
3. The activity heatmap, compact, with its intensity ramp taken from the Clay tokens.

**Right, "Read"**
Three stacked text lists, each with a small uppercase label:
1. **Continue**: pages and videos where you left off, each with a page number,
   percent or timestamp on the right.
2. **Deck**: the deck's Open questions column, meaning provocations whose status is
   `open` or `unsure`, sorted by `updatedAt` newest first. Each row shows its
   status on the right in Clay and opens the reader at that item's page, the same
   link the deck uses. This is new on the new tab. It is in the mockup the user
   picked and follows "align features with UI".
3. **News**: the triage ranking as today (5 picks, the reason for each, mute).
   It stays hidden during a focus round, as now.

**Foot**: two quiet text links, Papers and Settings. Favorites is gone.

Rules:
- Each list shows at most 5 rows, then a "Show all N" text button. No inner scroll.
- Rows are plain text: title on the left, metadata on the right, muted. No
  thumbnails or icons unless one is needed to tell a video from a page.
- Empty sections render a one-line hint or nothing, never an empty box.
- Keyboard navigation that exists today (selection, open, open in new tab) keeps working.
- Below about 720px the columns stack: Now first, then Read.
- Dark theme: same layout on warm charcoal, using the existing dark tokens.

## Other pages: the same restraint

Reader, papers, options, dumps, blocked, define, chime:
- Same tokens, the same hairline-and-space separation, small uppercase labels,
  Clay only for state and primary actions.
- Remove decorative elements: ornaments, gradients, shadows beyond the one
  elevation token, any motion that isn't a response to the user.
- The reader's text column and the metacognition margin card keep their current
  behaviour. Only the chrome around them gets quieter.
- Options shrinks to the sections the keep list needs.

## Constraints

- Start from commit `0c70025`, which landed the in-flight work (brain dump
  reset with schema v24, metacognition reader, define, chime, dumps). The v25
  migration builds on v24. `CLAUDE.md` shows as deleted in the working tree.
  Leave that alone, because it isn't part of this work.
- Read settings through `useSettings()`, never `useStorageValue('settings')`.
- Never animate the display serif's font-weight. It is a static face in Chrome.
- New CSS uses tokens only, and the token lint must pass.
- `npm test`, typecheck, build and `/verify` must pass. Update e2e specs that
  touch cut UI (`smoke`, `load`, `triage`, `continue`), and delete specs for
  features that no longer exist.

## Decided by the user

- Keep: research deck, RSS, continue row, brain dump, reader, Pomodoro, heatmap.
- Cut everything else on the new tab and in the background.
- The Pomodoro keeps blocking distracting sites during a focus session.
- News keeps the smart ranking; metacognition stays.
- Layout C. All pages get the same minimal treatment.
- Features align with the UI.
- Reading nudges are cut, including the `nudge` field on progress records.
- Unlisted settings: keep muted topics, the Semantic Scholar key, the reader
  display settings and the notifications toggle. Cut Flowtunes, suggested feeds,
  Gemini and AI stats.

## Claude's calls (flag if wrong)

- The Deck list is added to the new tab because layout C shows it.
- Continue keeps the current reading/watching split as two short sub-lists under
  one Continue label, but drops the video category grouping.
- Deck on the new tab shows open questions only. Claims and doubts stay in the
  full deck, in the reader and on the papers page.
- The Pomodoro intention (clock-in input, quote on the blocked page) stays as
  behaviour. It isn't shown in the new-tab status line.
- No masthead at all, so no date or greeting anywhere.
- The serif is used for the clock only on the new tab. Reader headings keep theirs.

## Left to the builder

- Exact spacing and type sizes within the existing scale.
- The order of deletion commits, and how to split them.
- Copy for empty states and the idle Start control.
- Whether `EditionIndex.tsx` survives as the two-link foot or gets folded into the Dashboard.
