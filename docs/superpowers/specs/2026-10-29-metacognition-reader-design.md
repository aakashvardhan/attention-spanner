# Metacognition reader: AI as a tool for thought

Date: 2026-10-29. Mockups: https://www.figma.com/design/v78SxOZoPes508DhOQrCAJ (five screens plus a components board, approved).

## Intent

The PDF reader and the paper deck should make the reader think about the paper and about their own thinking, instead of thinking for them. AI stops producing final outputs (summaries, answers, definitions, sorted highlights). It becomes a partner that asks, challenges, points out gaps and fallacies in the reader's own reasoning, and offers counterarguments. The human reads, synthesises and makes the judgement calls. Socratic questions ("provocations"), not chat.

### Why

The user reads papers with the three-pass approach. The skim (pass 1) works. Pass 2 fails two ways:

1. They highlight a lot but never question anything. A highlight is a dead end.
2. They stall on equations, algorithm pseudocode and unfamiliar terms: either click-to-define (an answer with no effort) or get overwhelmed and move on. The densest parts get the least thought.

Today almost every AI feature in the reader hands over the answer, which makes both failures worse.

### Success

After pass 2 the user can state the paper's main claim in their own words, say what they believe and why, and name the specific equation or step they still don't understand. After finishing a paper, the deck holds their claims, doubts and open questions, and they want to go back and read it.

## Goals

- Provocations at the moments the reading breaks down: after a highlight, at a page turn, at an equation, pseudocode block or unfamiliar term, on reopening a paper, and as the replacement for asking a question.
- The AI critiques what the user writes (their highlight reasons, one-liners, justifications): fallacies, gaps, counterarguments. It does not critique the paper on the user's behalf.
- Pass-aware strictness, chosen by the user with a manual switch.
- A deck that shows each paper's thinking record and pulls the user back into unresolved questions.
- A minimal, distraction-free UI. Nothing covers the PDF except the transient card the user is answering.

## Non-goals

- Article reader changes (see "Left to the builder" for shared components).
- Changes to RSS, YouTube, focus mode, the newtab, or the vault work on this branch.
- Automatic detection of which pass the user is on.

## Anti-goals (failure even if it works)

- Any chat interface or chat-shaped thread.
- AI output that the user can read in place of the paper: summaries, answers, solutions, worked-through equations.
- Clutter on the PDF: cards stacking over text, banners, recaps over the page.
- Gamification that rewards volume or attendance: streaks, badges, points per answer. The XP below is the one exception, and it rewards only thinking moves.

## The design (decided with the user)

### Pass switch

- A `Pass 1 / 2 / 3` segmented switch inside the existing bottom capsule (`ReaderCapsule`). Manual. Saved on the paper record. It stays where the user left it until they change it.
- Pass 1 (skim): nothing prompts. No margin provocations, no page-turn prompt.
- Pass 2: provocations appear in the right margin. The user can scroll past them, and they stay visible next to their anchor.
- Pass 3: an unanswered provocation locks scrolling until the user answers it.

### Feature changes ("the split", user-approved)

| Today | Becomes |
|---|---|
| Highlight colour pill (`SelectionMenu`) | Highlighting asks you to tag it Claim, Evidence or Doubt, and asks "Why, in one line" (margin card, screen 1). The reason is saved as the annotation's note. |
| Page recap card on every page turn (`PageRecap`) | One line in the capsule: "In one line, what did page N claim?" plus Answer. Clicking Answer grows the capsule into a single field (screen 4). There's no card over the page. |
| Ask sheet chat (`AskSheet`) | "Question it". It turns your question back into a Socratic prompt and points to the page where the answer lives. It never answers. |
| Click-to-define (`DefinePopover`) | Guess first: "From the sentence around it, what do you think X means here?" The real definition appears only after you've written a guess, shown next to your guess for comparison (screen 2). |
| Equations and pseudocode | Detected blocks get a margin provocation: in your own words, what does this term or line do? After you've tried, "Break it down" gives you smaller questions, never the solution (screen 1). |
| Recap card on reopen (`RecapCard` in `PdfReader`) | Removed. (The first-principles pass cut the reopen prompt: the margin, the page one-liners and the open questions already pull you back in.) |
| AI outline is the default outline tab | AI outline stays; Contents becomes the default tab. |
| Highlight matrix sorted by Laya (`PaperMatrix`) | Removed. Each paper's Claims, Doubts and Open questions columns replace it. |

Everything else in the reader stays as it is (citations, figures, find, focus line, drift nudge, notes sidebar, progress tracking).

### Counterpoints

When the user commits a highlight reason, a one-liner, or a pass 3 justification, the AI may answer with a counterpoint card under it (screen 2). The card names the possible gap in the user's reasoning in one short line, then gives three actions: Defend it, Revise, and a jump to the relevant section. Counterpoints target the user's reasoning, not the paper.

### Pass 3 lock (screen 3)

- **Which pages lock** (the user asked for my recommendation; this is it): only pages with something to settle. That means a page with a detected equation or pseudocode block, or a page that still has an open provocation. There's also a floor of at least one lock per top-level section. Most pages don't lock. (The first-principles pass cut the "page answers an earlier Doubt" trigger, because it was an unreliable heuristic and the section floor already covers it.)
- The page fades out below a centred card that says "Pass 3 · scrolling paused" and asks one justification question tied to the page. The card says why it's asking (for example: "on page 4 you tagged this as a Doubt; this page is where the authors answer it").
- One sentence unlocks "Continue reading". "I don't know yet" also unlocks, and the question is filed as an open question.
- The capsule shows only position while locked.

### Open questions

- Every skipped or unanswered provocation goes into a per-paper Open questions list. Each entry links back to its page.
- The toolbar shows an "Open questions N" chip (screen 1). Clicking it jumps to the next open question and raises it again in the margin. There's no separate panel.

### Deck (screen 5)

- Each paper record shows a one-line verdict in your own words, a pass pill, and an "N still open" pill.
- Three columns in your own words: **Claims** (Claim-tagged highlights and one-liners), **Doubts** (Doubt-tagged highlights, counterpoints and what you did with them, pass 3 justifications), and **Open questions** (skipped or unanswered provocations). Every item links to its page.
- Above the papers, "Today's question" is one card. It's drawn from the user's own past doubts or open questions in that deck, and it gives three actions: Answer in one line, Reopen at p. N, and Not today.
- The visual language is type-led and spacious. Serif for the user's own words and for questions. No badges or streaks.

### XP (added by the user after approval)

- XP rewards thinking moves only, never volume. The user decided this. Answering a page one-liner, tagging a highlight, or typing into the lock earns nothing on its own.
- Earning moves (point values are my call):
  - Resolve an open question: 10.
  - Revise a claim after a counterpoint: 15.
  - Defend against a counterpoint with a page reference: 15.
  - Write a paper's verdict: 20.
- Each move earns XP once per record, so editing the same answer again earns nothing.
- Shown in the deck only (user decision): the deck header shows a running total. Each paper record shows the XP its thinking earned. XP never appears in the reader.
- No levels, streaks, or leaderboards.

### Visual system

Use the existing tokens in `src/shared/theme.css` (Clay accent, Edition palette, `--font-sans` Atkinson Hyperlegible, `--font-display` serif). New CSS must use tokens (the `designSystem.test.ts` lint enforces this). The mockups use Newsreader as a stand-in for the system serif, and their sizes and spacing come from the token scale.

## Calls I made (the user hasn't confirmed these; they're cheap to change)

- "I don't know yet" unlocks pass 3 and files an open question. This is the honest exit, so the lock never forces a fake answer.
- Today's question may reword an open doubt in light of papers read since, when the user's own records connect them. Otherwise it shows the original question as written.
- Tagging sets the highlight colour (one colour per tag), and the free colour swatches go away.
- Pass 1 still offers the tag chips when you highlight. It just never raises a provocation on its own.
- At most one automatic margin provocation per page in pass 2, so the margin never stacks. More can be opened on demand.
- The verdict is asked for in the capsule when the user reaches the last page in pass 2 or 3, and it can be edited in the deck.
- Templated questions where no AI is needed: the page one-liner, the highlight tag and why, and the reopen prompt are fixed text. The AI writes the equation and term questions, the "Break it down" sub-questions, counterpoints, Socratic replies in Question it, pass 3 justification questions, and the rewording of Today's question.
- Only an explicit Skip, "I don't know yet", or a provocation still unanswered when you leave the paper files an Open question. Page one-liners you scroll past are never filed. This keeps the Open questions list meaningful.
- One counterpoint per committed answer. Defend it or Revise is the last word: it's recorded, and the AI does not reply again. Anything more would be a chat thread.
- Without AI, or while it's slow: every AI-written kind has a fixed fallback question ("In your own words, what does this line do?", "What would have to be true for this to hold?"). The pass 3 lock uses the fallback instead of waiting, and questions are pre-generated in the background for the next page. Question it falls back to "Where in the paper would you look for this?" plus Find. Counterpoints and "Break it down" are simply absent.
- Guess-first define applies in every pass, because you start it yourself. Tags are optional. An untagged highlight keeps the default colour, stays out of the matrix and the deck columns, and existing highlights migrate untagged.
- AI calls follow the existing routing (`src/shared/llm/route.ts`, Haiku-first cloud modes, local `think:false`), with new task names for the provocation kinds.

## Data (direction, not schema)

- Paper: add the current pass and a verdict.
- Annotation: add an optional tag (claim, evidence, doubt). The reason uses the existing `note`.
- A new provocation record: document and paper, page, kind, the question shown, the user's answer, status (open, answered, skipped), and the parent record for counterpoints. The deck columns and open-question counts are derived from these records plus tagged annotations.
- This needs a storage schema bump (currently v23 in `src/shared/storage.ts`), with existing data migrated without loss.

## Left to the builder

- How equation and pseudocode blocks are detected on a PDF page (text-layer heuristics, "Algorithm N" captions, symbol density). False negatives are acceptable. A dashed outline on hover plus click-to-provoke covers what auto-detection misses.
- Exactly which navigation the lock blocks. Forward scrolling, page jump, outline and find jumps past the page are blocked. Going back is allowed.
- Pages too short to question (title pages, figure-only pages) are exempt from page prompts and the lock. Reuse the `MIN_PAGE_CHARS` idea from `PageRecap`.
- Untracked PDFs have no paper record. The pass is held for the session only, and the existing TrackPrompt is the way to keep it.
- What to do with the shared components the article reader also uses (`SelectionMenu`, `DefinePopover`, `AskSheet`, `RecapCard`). The only constraint is the non-goal above: article reader behaviour must not regress.
- Prompt wording for every AI task, within the anti-goals. Every prompt must forbid answering, summarising, or solving.
- Tests follow the repo's existing patterns (`*.test.ts` beside modules, e2e under `e2e/`).
