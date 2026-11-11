# Metacognition Reader Implementation Plan

> **Status (2026-11-10): archived.** Written for the TypeScript extension, which the
> Rust port deleted (see `docs/superpowers/specs/2026-11-02-rust-port-design.md`), so most
> paths and code named here no longer exist. What shipped lives on in `rust/`; the README
> describes the current behaviour. Its boxes were never ticked, so they say nothing about what was built.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The PDF reader stops handing over answers and starts asking. Highlights get a tag and a reason, which the AI may challenge. Equations and terms ask for your guess first. A manual pass switch makes pass 3 stop you at pages worth justifying. The deck shows your own claims, doubts and open questions, with XP for thinking moves.

**Architecture:** Two pure, tested modules hold the logic: `src/shared/thinking.ts` (XP, deck columns, today's question) and `src/pages/reader/passGate.ts` (math detection, which page locks). Prompts and fixed fallbacks live in `src/shared/llm/provoke.ts`. One new storage key, `provocations`, is written only through the service worker. The reader UI adds three components (margin card, counterpoint, lock) and extends the capsule. The article reader is untouched.

**Tech Stack:** TypeScript, React 18, Vite, Chrome MV3, vitest, the e2e harness in `e2e/` (Playwright), pdf.js.

**Spec:** `docs/superpowers/archive/specs/2026-10-29-metacognition-reader-design.md`. The mockups are in Figma file `v78SxOZoPes508DhOQrCAJ`, screens 1–5.

## Global Constraints

- No chat. No AI text that answers, summarises or solves. Every new system prompt ends with `NO_ANSWER_RULE`.
- New CSS uses `src/shared/theme.css` tokens only, and `designSystem.test.ts` must stay green. Questions and the user's own words use `var(--font-display)`. Never animate its `font-weight`.
- Read settings with `useSettings()`.
- XP is for thinking moves, once per record:
  - Resolve an open question: 10.
  - Revise a claim after a counterpoint: 15.
  - Defend against a counterpoint with a page reference: 15.
  - Write a verdict: 20.
  - XP is shown in the deck only, as a total and per paper. No levels, streaks or leaderboards.
- Storage changes are additive (optional fields, plus one new key with a default), so there's no schema bump and no `migrate()` change, per the note above `DEFAULTS` in `storage.ts`. Don't name a key `gamification` or `streaks`, because those are in `V22_DEAD_KEYS`.
- The working tree has unrelated uncommitted edits in files this plan touches. Stage by path only, never `git add -A`. Ask the user which base to use before Task 1.
- Before each commit: `npm test && npm run typecheck`. After the last task, run the `verify` skill.

## Review Focus

1. **A PDF with no outline:** the lock's once-per-section floor treats the whole document as section 0, so it locks once, not never or always. Test in Task 3.
2. **AI off or erroring while the lock is up:** the fixed fallback question shows at once, and the lock stays answerable. Test in Task 6.
3. **An untracked PDF (`paperId: null`):** the pass switch, margin cards and lock all work for the session. Tests in Tasks 4 and 6.
4. **Re-answering an answered record:** no second XP. Test in Task 2.
5. **A deleted highlight that has a counterpoint:** the deck doesn't show the orphan. Test in Task 2.

---

### Task 1: Types and storage

**Files:** Modify `src/shared/types.ts`, `src/shared/storage.ts`, `src/shared/constants.ts`. Test: `src/shared/storage.test.ts`.

**Produces:**
```ts
export type ReadingPass = 1 | 2 | 3;
export type HighlightTag = 'claim' | 'evidence' | 'doubt';
export type ProvocationKind = 'page' | 'equation' | 'lock' | 'counterpoint' | 'verdict';
/** open = skipped or left unanswered; unsure = "I don't know yet" (also open) */
export type ProvocationStatus = 'open' | 'unsure' | 'answered';
export interface Provocation {
  id: string; docKey: string; paperId: string | null; page: number;
  kind: ProvocationKind; question: string; answer: string; status: ProvocationStatus;
  /** counterpoint → the highlight it challenges */
  annotationId: string | null;
  /** counterpoint only */
  response?: 'defended' | 'revised';
  citedPage?: number;
  xp: number; createdAt: number; updatedAt: number;
}
export type ProvocationDraft = Omit<Provocation, 'id' | 'xp' | 'createdAt' | 'updatedAt'>;
```
- `Paper` gains `pass?: ReadingPass; verdict?: string`. `Annotation` gains `tag?: HighlightTag`.
- `LocalSchema.provocations: Provocation[]`, with `DEFAULTS.provocations = []`.
- `MAX_PROVOCATIONS = 5000` and `MIN_PAGE_CHARS = 300` go in `constants.ts`.

- [ ] **Step 1:** Add the test `it('defaults provocations to an empty list and keeps schema 23')`.
- [ ] **Step 2:** Run `npx vitest run src/shared/storage.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Add the types, the key and the constants.
- [ ] **Step 4:** Run `npx vitest run src/shared/storage.test.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit the four files by path: "Provocations: types and storage key".

### Task 2: `thinking.ts`

**Files:** Create `src/shared/thinking.ts` and `src/shared/thinking.test.ts`.

**Produces:**
```ts
export const XP = { resolve: 10, revise: 15, defend: 15, verdict: 20 } as const;
export const TAG_COLOR: Record<HighlightTag, AnnotationColor> = { claim: 'blue', evidence: 'green', doubt: 'pink' };
/** prev null = new record. 0 when prev.xp > 0. */
export function xpAward(prev: Provocation | null, next: Provocation): number;
export interface ThinkingItem { id: string; text: string; page: number; note: string }
export interface PaperThinking { claims: ThinkingItem[]; doubts: ThinkingItem[]; open: ThinkingItem[]; xp: number }
export function paperThinking(paperId: string, annotations: readonly Annotation[], provocations: readonly Provocation[]): PaperThinking;
/** An open/unsure record from these papers, stable for a local day; doubts' counterpoints first. */
export function todaysQuestion(paperIds: readonly string[], provocations: readonly Provocation[], dayKey: string): Provocation | null;
```
- **XP rules:**
  - open or unsure → answered: `resolve`.
  - A counterpoint gaining `'revised'`: `revise`.
  - A counterpoint gaining `'defended'` with a `citedPage`: `defend`. Without one: 0.
  - A new `verdict` that is answered: `verdict`.
  - Otherwise 0, and always 0 once `prev.xp > 0`.
- **Columns:**
  - claims: `claim`-tagged highlights (note = the reason), plus answered `page` records.
  - doubts: `doubt`-tagged highlights, plus answered `counterpoint` records (note `you held your position` or `you revised`), plus answered `lock` records (note `you justified this to unlock pass 3`).
  - open: open or unsure records of any kind except `page`.
  - Drop records whose `annotationId` no longer exists. Sort each column by page. `xp` is the paper's sum.

- [ ] **Step 1:** Write these tests:
  - `open→answered gives 10`
  - `already-awarded gives 0`
  - `born-answered page record gives 0`
  - `revised 15, defended with page 15, defended without page 0`
  - `new verdict 20`
  - `columns sort tagged highlights and answered records by page`
  - `open excludes page records, includes unsure`
  - `drops counterpoints on deleted highlights`
  - `today's question is stable within a day, rotates across days, null when nothing is open`
- [ ] **Step 2:** Run `npx vitest run src/shared/thinking.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. For `todaysQuestion`, use a stable hash of `dayKey` modulo the candidate count, with candidates ordered by `createdAt`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: "Thinking record: XP for thinking moves and deck columns".

### Task 3: Prompts, routing, pass gate

**Files:**
- Create `src/shared/llm/provoke.ts` and `src/pages/reader/passGate.ts`.
- Modify `src/shared/llm/route.ts` (line 19 for the union, line 76 for the short-task branch).
- Tests: `provoke.test.ts`, `passGate.test.ts`, `route.test.ts`.

**Produces (`provoke.ts`):**
```ts
export const NO_ANSWER_RULE = ' Never answer, summarise, explain or solve. Ask exactly one question, at most 30 words. No preamble, no emoji.';
export const FALLBACK = {
  equation: 'In your own words, what does this line do?',
  breakdown: ['What does each symbol stand for?', 'Which term would change the result most if it were removed?', 'What would have to be true for this to hold?'],
  question: 'Where in the paper would you look for this?',
  lock: 'What would have to be true for this page’s claim to hold, and does it?',
} as const;
export function equationRequest(o: { key: string; page: number; block: string; source: AiSource }): AiRequest;
export function breakdownRequest(o: { key: string; page: number; block: string; guess: string; source: AiSource }): AiRequest;
export function parseBreakdown(text: string): string[]; // [] when unparseable
export function socraticSystem(): string;               // passed to the existing AskSheet
export function lockRequest(o: { key: string; page: number; pageText: string; doubts: string[]; source: AiSource }): AiRequest;
/** Reply "Q: …\nGap: …" or "NONE"; targets the reader's reasoning, names one gap or fallacy */
export function counterpointRequest(o: { key: string; passage: string; reasoning: string; source: AiSource }): AiRequest;
export function parseCounterpoint(text: string): { question: string; gap: string } | null;
```
- All requests use `task: 'provoke'` and a `cacheKey`.
- `route.ts`: add `'provoke'` to `AiTask` and to the `recap | triage | terms` branch.

**Produces (`passGate.ts`):**
```ts
/** First "Algorithm N" block or line with ≥8 math/Greek chars making ≥25% of non-space chars; ≤400 chars; '' if none */
export function mathBlock(pageText: string): string;
export function shouldLock(o: { pass: ReadingPass; pageText: string; section: number; lockedSections: ReadonlySet<number>; openOnPage: boolean }): boolean;
```
`shouldLock` returns true when `pass === 3`, the page has at least `MIN_PAGE_CHARS`, and at least one of these holds: `mathBlock(pageText)` is non-empty, `openOnPage`, or `!lockedSections.has(section)`. The caller passes `section = 0` when the PDF has no outline.

- [ ] **Step 1:** Write these tests:
  - `every request ends with NO_ANSWER_RULE and uses task provoke`
  - `parseCounterpoint reads Q/Gap, null for NONE`
  - `parseBreakdown reads 1./2./3.`
  - `mathBlock finds Algorithm 1 and a Greek-heavy line, ignores prose with one "="`
  - `shouldLock false in passes 1–2 and on short pages`
  - `first page of a section locks, the next plain page does not`
  - `no outline locks once, then only on math or open pages`
  - In `route.test.ts`: add `'provoke'` to `TASKS`, and `it('provoke stays on device under ask mode')`.
- [ ] **Step 2:** Run `npx vitest run src/shared/llm src/pages/reader/passGate.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: "Provocations: question-only prompts, fallbacks, which pages lock".

### Task 4: Service worker writes

**Files:**
- Create `src/background/provocations.ts` and its test, following `papers.test.ts`.
- Modify `src/shared/messages.ts`, `src/background/router.ts` and `src/background/annotations.ts`.

**Produces:**
- `{ type: 'PROV_ADD'; draft: ProvocationDraft }`, which returns `{ ok; provocation?; error? }`.
- `{ type: 'PROV_UPDATE'; id; patch: Partial<Pick<Provocation, 'answer' | 'status' | 'response' | 'citedPage'>> }`, which returns `{ ok; xp?; error? }`.
- `ANNOT_UPDATE`'s patch adds `'tag'`.
- Each write adds `xpAward(prev, next)` to `xp`. The text is capped at `ANNOTATION_TEXT_MAX_CHARS`. A null `paperId` is accepted. Writes are refused past `MAX_PROVOCATIONS`.

- [ ] **Step 1:** Write these tests:
  - `stores a record with null paperId`
  - `open→answered adds 10 once`
  - `refuses past the cap`
- [ ] **Step 2:** Run `npx vitest run src/background/provocations.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement, and wire the router.
- [ ] **Step 4:** Run `npx vitest run src/background && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: "Provocations: service-worker writes, XP once per record".

### Task 5: Reader components

**Files:**
- Create `ProvocationCard.tsx`, `CounterpointCard.tsx` and `PassLock.tsx` in `src/pages/reader/components/`.
- Modify `ReaderCapsule.tsx`, `SelectionMenu.tsx`, `DefinePopover.tsx`, `AskSheet.tsx`, `OutlineSidebar.tsx`, `ReaderToolbar.tsx` and `reader.css`.

**Produces:**
- **`ProvocationCard`** `{ kicker; question; tags?: boolean; placeholder; actionLabel; onCommit(answer, tag?); onSkip(); children? }`. It has `role="region"` with `aria-label={kicker}`, and the tags are a radiogroup named "Tag this highlight". It follows Figma screen 1.
- **`CounterpointCard`** `{ question; gap; onDefend(text, citedPage?); onRevise(text) }`. It allows one exchange, then becomes read-only.
- **`PassLock`** `{ question; onContinue(answer); onUnsure() }`. It's a fade plus a card with `role="dialog"` and `aria-label="Scrolling paused"`. "Continue reading" is enabled at 3 or more words. It follows Figma screen 3.
- **`ReaderCapsule`** gains:
  - `pass?`, plus `onPass?` (the switch renders only when this is set). The switch is a radiogroup named "Reading pass" with radios `Pass 1`–`Pass 3`.
  - `prompt?: { text; onAnswer(a); onSkip() } | null`. At rest it's one italic line plus "Answer". Answer expands it into a single field: Enter saves, Escape folds it. It's a group named "Reflection prompt".
- **`SelectionMenu`** gains `mode?: 'colors' | 'tags'` (default `'colors'`, so articles are unchanged), `onTag?(tag | null)` and `onQuestion?()`. Tags mode shows `Claim`, `Evidence`, `Doubt`, `Highlight` (untagged) and `Question this`.
- **`DefinePopover`** asks first: “From the sentence around it, what do you think “{word}” means here?”, with "Compare" disabled until something is typed. Compare runs the unchanged `defineRequest` and shows "Your guess" above the paper's meaning. A saved note reads `Your guess: … / Paper: …`.
- **`AskSheet`** gains optional `system?: string` and `thread?: boolean` (default `true`, so articles are unchanged). The PDF passes `socraticSystem()` and `thread={false}`, with heading "Question it" and placeholder "What are you trying to figure out?". When the AI is unavailable it shows `FALLBACK.question`.
- **`OutlineSidebar`** defaults to the `'contents'` tab when an outline exists.
- **`ReaderToolbar`** relabels Ask to "Question it" and adds the props `openCount` and `onNextOpen()`, which render "Open questions N" only when N > 0.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Run `npm run typecheck && npx vitest run src/shared/designSystem.test.ts src/shared/motion.test.ts`. Expected: PASS.
- [ ] **Step 3:** Commit: "Reader: margin cards, counterpoint, lock, pass switch, tag-first highlights, guess-first define".

(The behaviour is covered end to end in Task 6.)

### Task 6: Wire the PDF reader

**Files:**
- Create `src/pages/reader/useProvocations.ts` and `e2e/thinking.e2e.ts`.
- Modify `PdfReader.tsx`, `PdfViewport.tsx` and `e2e/reader.e2e.ts:150-242`.
- Delete `src/pages/reader/components/PageRecap.tsx`.

**Produces:** `useProvocations({ docKey, paperId, pass, page, pageCount, pageTexts, outline, source, annotations, paper })` returns `{ margin, capsulePrompt, lock, open, raiseForSelection, nextOpen }`.

`margin` is at most one card: `{ id; kind: 'highlight' | 'equation'; kicker; question; page; annotationId?; breakdown: string[] | null; counterpoint: { question; gap } | null } | null`.

**Rules:**
- **Pass 1:** only manual cards (a tag choice or "Question this"). No prompt and no lock.
- **Pass 2 page one-liner:** when you settle for 1200 ms on a new page moving forward (carry over PageRecap's once-per-page logic, then delete PageRecap), the capsule asks `In one line, what did page ${left} claim?`. Pages under `MIN_PAGE_CHARS` are exempt. An answer is stored as an answered `page` record. Skipping stores nothing.
- **Pass 2 equation:** at most one automatic card per page, when `mathBlock` is non-empty. It uses `equationRequest`, falling back to `FALLBACK.equation`. After you commit, "Break it down" shows `parseBreakdown`, or `FALLBACK.breakdown` when the reply doesn't parse. With no AI it isn't shown.
- **Highlight in tags mode:**
  1. A card asks why.
  2. Commit sends `ANNOT_UPDATE { tag, color: TAG_COLOR[tag], note }`.
  3. `counterpointRequest` runs next. A `null` parse means no card.
  4. Defend or Revise stores a `counterpoint` record (answered, with its `response`), which is where its XP comes from.
- **Verdict:** on the last page in pass 2 or 3, if `paper.verdict` is empty, the capsule asks `Your verdict on this paper, in one line?`. The answer is stored as a `verdict` record plus `PAPER_UPDATE { verdict }`.
- **Pass 3 lock:** when `shouldLock` is true for the page, the question comes from `lockRequest`, showing `FALLBACK.lock` at once when the route is `none` or errors.
  - An answer stores an answered `lock` record and unlocks.
  - "I don't know yet" stores an `unsure` `lock` record and unlocks.
- **Open questions:** `nextOpen()` jumps to the next open or unsure record's page and re-raises it as the margin card.
- **Leaving the paper:** on `pagehide`, a shown and unanswered equation card is stored as `open`.
- **Wiring:**
  - `PdfViewport` gains `lockAfterPage?: number | null`. It clamps scrollTop to that page's bottom and refuses `scrollToPosition` to later pages, while going back stays allowed. It also gains `selectionMode`, `onTag` and `onQuestion`.
  - In `PdfReader`, remove `RecapCard` and `PageRecap`. The pass is `paper?.pass ?? useState<ReadingPass>(1)`, and `onPass` sends `PAPER_UPDATE { pass }` when the paper is tracked.

- [ ] **Step 1:** Write the failing e2e tests.
  - Rewrite `reader.e2e.ts:150` as `asks for a guess before defining, and a one-liner for the page just left`:
    - The `Definition of transformer` dialog shows Compare disabled. After typing `a model`, it shows `Your guess` and `attention-based sequence model`.
    - Switch to `Pass 2`, move to page 2, and the `Reflection prompt` reads `what did page 1 claim?`.
    - No `Recap of page 1` appears.
  - Rewrite the test at `:195` so the saved note reads `Your guess: a model / Paper: Transformer: …`.
  - Create `thinking.e2e.ts`, following `reader.e2e.ts` for `makePdf` and the chat mock. The mock replies `Q: Would it hold if only λ changed?\nGap: a confounded comparison.` when the system prompt contains `reasoning`. Tests:
    - `tagging a highlight Doubt with a reason draws a counterpoint; Revise stores 15 XP`. Assert the annotation `tag: 'doubt'` and a counterpoint with `xp: 15` in storage.
    - `untracked PDF, pass 3, AI off: the first page locks with the fallback, scrolling stays on page 1, "I don't know yet" unlocks and shows Open questions 1`. Seed `ollamaChatModel: ''`.
- [ ] **Step 2:** Run `npm run build:e2e && npx vitest run --config vitest.e2e.config.ts e2e/reader.e2e.ts e2e/thinking.e2e.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Delete `PageRecap.tsx`.
- [ ] **Step 4:** Run the same command, then `npm test && npm run typecheck`. Expected: PASS. The web-page Alt-click define test (`reader.e2e.ts:330`) still passes.
- [ ] **Step 5:** Commit the files by path, plus `git rm` of PageRecap: "PDF reader: provocations by pass, pass-3 lock, no recaps".

### Task 7: Deck

**Files:**
- Create `src/pages/papers/components/PaperRecord.tsx`.
- Modify `PaperDeckView.tsx`, `PaperRow.tsx` and `papers.css`.
- Delete `PaperMatrix.tsx`, `src/shared/llm/matrix.ts` and `matrix.test.ts`, plus `updateRoles` in `src/shared/llm/store.ts` if nothing else calls it (check with `grep -rn updateRoles src`).
- Extend `e2e/thinking.e2e.ts`.

**Produces:**
- `PaperRecord({ paper, thinking })` shows:
  - The verdict line in display italic, or "No verdict yet."
  - A `Pass N` pill, an `N still open` pill and `+X XP`.
  - Three columns (Claims, Doubts, Open questions). Each item links to `readerPageUrl(paper.pdf?.url ?? paper.url) + '#page=N'`. If the reader doesn't honour `#page`, add that to `PdfReader`'s initial position in this task.
  - It follows Figma screen 5, and `PaperRow` renders it in its expanded state.
- `PaperDeckView`:
  - The header shows `{total} XP` in muted sans.
  - Above the list is one "Today's question · from your own doubt" card from `todaysQuestion`. Its answer field sends `PROV_UPDATE { status: 'answered', answer }`. "Not today" hides it for the local day (`sessionStorage`, wrapped in try/catch).
  - The matrix toggle goes.

- [ ] **Step 1:** Write the e2e test `deck shows claims, doubts and open questions; answering today's question gives 10 XP`.
  - Seed one deck, one paper, a claim highlight on p3, a doubt on p4 and an open record on p6.
  - Expand the row, and assert the columns, `1 still open` and the card text.
  - Answer the card, and assert `10 XP` and that the pill is gone.
- [ ] **Step 2:** Run `npm run build:e2e && npx vitest run --config vitest.e2e.config.ts e2e/thinking.e2e.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement, and delete the matrix files.
- [ ] **Step 4:** Run the same command, then `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit by path, plus `git rm` of the deleted files: "Deck: your claims, doubts, open questions and XP".

### Task 8: Verify

- [ ] **Step 1:** Run `npm test && npm run typecheck && npm run build:e2e && npm run test:e2e`. Expected: all PASS, including `smoke.e2e.ts` a11y on the reader and papers pages.
- [ ] **Step 2:** Run the `verify` skill. Screenshot pass 2 with a margin card, the pass 3 lock, the capsule prompt and an expanded deck record, then compare them against Figma screens 1–5.
- [ ] **Step 3:** Fix visual gaps in the owning component, and commit by path.
