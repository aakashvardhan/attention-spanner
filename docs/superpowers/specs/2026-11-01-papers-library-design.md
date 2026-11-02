# Papers Library: alphaXiv companion, ADHD intuition reader, wood shelf

## Context
The extension (about 36k LOC: RSS, YouTube, topic gate, Ollama/Haiku/Laya, articles, Pomodoro and more) becomes a single-purpose companion to the user's paid alphaXiv account, used to read and track research papers.

The user named the real failure in the interview: **another tab pulls them off the paper**, not difficulty. Success means that after about 20 minutes, without finishing the paper, they can **explain it to a friend**: the problem, the key trick, and why it works.

The reader stays "ask, never tell". alphaXiv is the master copy of the library. The look across the whole extension becomes calm wood dark brown with brass accents.

## Decisions (from the interview)
| Area | Decision |
|---|---|
| Library master | **alphaXiv folders**. The extension mirrors them and adds only reading state: progress, where you stopped, explain-backs, gaps. |
| alphaXiv access | **Inside the extension.** The background worker calls `https://api.alphaxiv.org/mcp/v1` with OAuth. If the sign-in spike fails, **stop and re-plan with the user**. |
| alphaXiv features | Feeds (shown as a New-arrivals cart by the shelf), paper content and PDF Q&A (behind the scenes), highlights imported **one-way**. |
| Extension's own AI | **Delete** Ollama, routing, Laya, recap, outline, recall, triage, terms, provoke. **Keep Haiku (`llm/claude.ts`) only for the brain-dump reframe.** |
| Reader | Full PDF, quiet margin. **No pass 1/2/3, no pass-3 lock.** No signposts (the user chooses where to read). |
| Questions | Shown at the end of a section, or on a stall (long dwell with no scroll). alphaXiv PDF Q&A writes them from the section text. |
| Explain-back | Problem, trick, and why it works. alphaXiv grades it and replies with the **gap and where to look** ("You named the trick but not why it works; see §3.2"), never the answer. |
| Define | Click a term and alphaXiv defines it in this paper's context. This is the one place the reader tells. |
| Focus | A session blocks distracting sites **while the reader tab is active**. Pomodoro, chime, FocusTimer and hold-to-quit go. |
| Scope | arXiv/alphaXiv papers only. Other PDFs open in Chrome's own viewer. |
| Migration | Old papers with an arXiv id are pushed once into a matching alphaXiv folder, keeping progress. Non-arXiv papers and their annotations are **deleted**. |
| Theme | Walnut frame. PDF pages recolored to cream on dark brown, with figures kept in true color. Covers the **whole extension**, replacing Clay/Edition. |
| A11y bar | **WCAG 2.2 AAA** (7:1 text) plus **W3C COGA** (Making Content Usable). Full keyboard support, reduced motion, axe-clean. |
| Shelf | Shelf = alphaXiv folder. Spine shows a short code (e.g. "Mamba '23"). Thickness = page count, wear = progress. Hover or focus tilts the book out with a horizontal plate. Enter pulls out a card (last explain-back, open gaps, where you stopped, Continue). Drag, or a keyboard "Move to shelf" menu, moves the paper between alphaXiv folders. |
| New tab | Continue reading (paper plus open gaps), activity heatmap, brain dump. |
| Branch | New branch `papers-library` off `minimal-revamp`. Do not commit the pending `CLAUDE.md` deletion. |

## Step 0: Branch, spec, alphaXiv spike (gate)
- `git switch -c papers-library`. Commit this design as `docs/superpowers/specs/2026-11-01-papers-library-design.md`.
- **Spike** (throwaway, `scripts/spike-alphaxiv/`), implemented in the background worker:
  1. Discover the OAuth endpoints from the protected-resource metadata.
  2. Register the extension as a client (dynamic registration).
  3. Run `chrome.identity.launchWebAuthFlow` with redirect `https://<ext-id>.chromiumapp.org/`.
  4. Call `list_library` through `@modelcontextprotocol/sdk`'s `Client` + `StreamableHTTPClientTransport` (already a dependency) with an `OAuthClientProvider`.
- Record real responses for `list_library`, `get_paper_content`, `answer_pdf_queries`, `get_paper_notes`, `get_hot_feed`, `get_for_you_feed`, `save_papers_to_folder` and `move_papers_between_folders` as fixtures for the contract tests.
- **Gate:** if alphaXiv refuses the client, the redirect, or CORS from `chrome-extension://`, stop and re-plan with the user.

## Step 1: First-principles delete
Delete, along with the tests, messages, settings fields, options rows and manifest permissions/commands that belong to each:
- RSS: `background/feeds.ts`, `rssParser.ts`, `shared/feedDiscovery.ts`, `llm/triage.ts`, `TriageCard.tsx`
- Video: `background/videoTracking.ts`, `videoContext.ts`, `shared/youtube*.ts`, `content/videoTracker.ts`, `timedtextTee.ts`, `watchMeta.ts`
- Topic gate: `background/topicGate.ts`, `llm/geminiTopic.ts`, `shared/topics.ts`, `MutedTopicsRow`, `TrackTopicsRow`, `e2e/mutedTopics.e2e.ts`
- Web tracking: `background/tracking.ts`, `content/readingTracker.ts`, `ContinueRow.tsx` (replaced in step 6)
- AI: `llm/route.ts`, `ollama.ts`, `laya.ts`, `scripts/laya-server/`, `recap.ts`, `RecapCard`, `outline.ts`, `recall.ts`, `RecallSearch`, `vectors.ts`, `terms.ts`, `provoke.ts`, `intake.ts`, `LocalAiSection.tsx`, `e2e/ollamaMock.ts`, `triage.e2e.ts`. Keep `llm/claude.ts` and whatever `BrainDump` imports from `generate.ts`/`store.ts` (trace this before deleting).
- Reader: `ArticleReader`, `ArticleViewport`, `articleExtract`, `useArticleDocument`, `articleProgress`, `passGate`, `PassLock`, `CounterpointCard`, `useProvocations` (rewritten in step 4), `shared/thinking.ts`, citation tools (`bibliography.ts`, `citeFormats.ts`, `CitationTooltip`, `citationLinks`, `TrackPrompt`), `content/define.ts`, `pages/define`
- Focus: `FocusTimer`, `FocusDial`, `HoldToQuit`, `pages/chime`, the Pomodoro parts of `background/focus.ts`. **Keep** `accessRules.ts`, `shared/focusRules.ts` and `pages/blocked` for the session block.
- Metadata: the Semantic Scholar path in `background/papers.ts`. Decks in `flashcards.ts` are replaced by folders.
- Storage: schema v27 migration in `src/shared/storage.ts` that adds the cut keys to the retired list. Non-arXiv papers and their annotations are removed; arXiv ones are queued for the step 2 push.
- **Tests:** add every cut module and identifier to `src/shared/cutFeatures.test.ts`. Unit-test the v27 migration (arXiv kept, non-arXiv dropped, annotations of dropped papers dropped, idempotent). Run `npm run typecheck && npm test && npm run build:e2e && npm run test:e2e` until green.

## Step 2: alphaXiv client (background)
- `src/background/alphaxiv.ts`:
  - An SDK `Client` with the OAuth provider from step 0. Tokens are stored in `chrome.storage.local` and refreshed on 401.
  - Thin typed wrappers for each tool, validated with **zod** (already installed).
  - Errors map to `signed-out | rate-limited | not-found | offline`.
  - Options page: Sign in / Sign out row.
- Sync:
  - `list_library` mirrors into `papers` (keyed by arXiv id), with folders as shelves, on new-tab open and on `alarms.ts`. Local reading state is merged in and never overwritten.
  - Migration push, run once: `save_papers_to_folder` for the queued v27 papers, into the folder matching their old deck name (created if missing).
  - Highlights: `get_paper_notes` feeds a read-only `alphaxivNotes` layer in the reader.
- `background/pdfIntercept.ts`: intercept only arXiv/alphaXiv PDF URLs.
- **Contract tests:** feed the step 0 fixtures through the parsers. Edge cases: 401 followed by refresh, refresh failure leading to signed-out, 429 backoff, offline, a paper alphaXiv doesn't have, an empty library, a folder renamed or removed on alphaXiv (the paper's local state survives), a duplicate paper in two folders.

## Step 3: Wood + brass design system (whole extension)
- Rewrite the tokens in `src/shared/theme.css`: walnut surfaces, cream text, brass accent, and focus ring. Retire light, dark, paperwhite and Clay. Keep the existing token names wherever possible so components don't churn. Keep Atkinson Hyperlegible.
- `src/shared/contrast.test.ts`: parse the tokens and assert ≥7:1 for every text/surface pair actually used, ≥3:1 for UI borders and the focus ring (WCAG 2.4.13).
- Keep `designSystem.test.ts` and `motion.test.ts` passing. Every wood-grain or wear effect must be built from tokens; ds-exempt only with a reason.
- Add Playwright screenshot regression (`toHaveScreenshot`) to the e2e harness for the shelf, reader, new tab and options. Approve baselines at the end of each step.

## Step 4: Reader (`src/pages/reader/`)
- **Recolor:** a walnut duotone on page canvases (reuse the paperwhite duotone mechanism at `reader.css:~902`). Images and figures are detected via `figures.ts` and keep true color.
- **COGA:**
  - One column, with no chrome except a slim top bar showing the title, page n/N and session state.
  - Generous line height and focus-line support (`useFocusLineKey`).
  - Every action has a visible label and a key.
  - Where you stopped is restored and shown (support memory).
  - Nothing moves unless the user acts.
- **Questions:** `useQuestions.ts` replaces `useProvocations`. Section ends come from the `pdfOutline.ts` headings plus the scroll position. A stall is a dwell of N seconds with no scroll; N is a settings knob with a sensible default. It calls `answer_pdf_queries` with a "write one Socratic question about this section, do not explain" prompt and caches per paper and section. Questions appear in a margin card that can be dismissed with a key.
- **Explain-back:** an `ExplainBack` sheet with three fields (problem, trick, why). It is offered on close, from the button, or by key. `answer_pdf_queries` returns JSON grading `{part, status, gap, where}`. The UI shows only the gap and where, with a link to jump to that page. Stored per paper with history.
- **Define:** keep `DefinePopover` and `clickedWord.ts`, now backed by `answer_pdf_queries`.
- **Annotations:** the local highlights and notes stay. alphaXiv highlights render in a distinct read-only style.
- **Session block:** when the reader tab gains or loses activity, background `focus.ts` enables or disables `accessRules` (reusing the existing block list and `pages/blocked`).
- **Tests:**
  - Unit: section-end and stall detection, the question cache, parsing the grading JSON (including malformed output), the gap-only rendering rule (the answer is never shown).
  - e2e: open a fixture arXiv PDF, scroll past a section and get a question, submit an explain-back and see the gap and where, switch tabs and confirm the block is active and a blocked site is redirected, leave the reader and confirm the block is lifted.
  - Plus axe and a screenshot.

## Step 5: Shelf (`src/pages/papers/`)
- `Papers.tsx` becomes a bookcase: one shelf per alphaXiv folder, books sized from `pdf.pageCount`, wear derived from `progressPercent`.
- Interaction:
  - Roving tabindex with arrows across books and shelves.
  - Focus or hover tilts the book and shows a horizontal plate (title, authors, progress).
  - Enter opens the pull-out card. Continue opens the reader at `leftOff`.
  - `M` opens a Move-to-shelf menu (the accessible equivalent of drag); drag uses native HTML5 DnD. Both call `move_papers_between_folders` optimistically and roll back on error.
- Motion: tilt and pull-out use spring tokens and are disabled under `prefers-reduced-motion` (enforced by `motion.test.ts`).
- **New-arrivals cart:** Hot and For You lists. `S` shelves a paper into a folder through `save_papers_to_folder`.
- **Tests:**
  - Unit: spine-code shortening (long titles, non-Latin titles, missing year), thickness and wear mapping (0 pages, 100%), roving-focus logic, optimistic move with rollback.
  - e2e: keyboard-only shelving and moving, a screen-reader name on every book, axe, screenshots.

## Step 6: New tab (`src/pages/newtab/`)
- `Dashboard.tsx` gets three cards: **Continue reading** (last paper with its open gaps, opening at `leftOff`), `ActivityHeatmap` (fed from reader progress only), `BrainDump` (Haiku reframe unchanged). `EditionIndex`, `DeckList`, `TriageCard` and `FocusTimer` go.
- **Tests:** update `newtab.e2e.ts` and `smoke.e2e.ts`, plus axe and a screenshot. Run the full suite.

## Process every step
TDD (a failing test first). Each step ends green on `npm run typecheck && npm test && npm run build:e2e && npm run test:e2e`. Run `/verify` before each commit. One commit per step on `papers-library`. Update the memory notes (phased plan, metacognition-reader, use-settings-hook) at the end.

## Verification (end to end)
1. `npm run build`, then load `dist/` unpacked and sign in to alphaXiv from options.
2. The shelf shows the real alphaXiv folders. Move a book with the keyboard and confirm the folder changed on alphaXiv.
3. Open a paper from the shelf in the walnut reader. Scroll past a section and get a question. Switch tabs to a blocked site and get redirected. Submit an explain-back and see the gap and where. Confirm no answer text appears anywhere.
4. The new tab shows Continue reading with that paper's gaps.
5. The full test suite passes, including contrast, screenshots, cut-features, contract tests and axe.
