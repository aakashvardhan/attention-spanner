# Sidebars (webpage + YouTube) and your own papers

Date: 2026-11-07. Branch: papers-library. Extension is Rust/wasm (rust/ext, rust/core; Leptos).

## Why

The user reads more than alphaXiv papers: course notes on the web (example: https://cs2680.seas.harvard.edu/notes/agent-evaluation, MathJax/KaTeX math), lecture/tutorial/educational YouTube videos, and papers alphaXiv doesn't have. The paper reader's Listen and Talk it through work well; they want the same on any page, video takeaways on YouTube, and a way to shelve papers alphaXiv doesn't hold.

Three parts, built in this order (builder's call, the user didn't pick one): 1 webpage sidebar, 2 YouTube sidebar, 3 own papers and decks. Each part ships working before the next starts.

## Shared: the toolbar icon opens a side panel

- Toolbar icon click opens a Chrome side panel (`chrome.sidePanel`, `setPanelBehavior({openPanelOnActionClick: true})`) on every tab. The current `on_action_clicked` (opens the new tab) goes away; the user said the new tab already shows on every new tab, so the icon doesn't need to open it.
- One side panel page. It looks at the active tab's URL: a YouTube watch page (`youtube.com/watch?v=`, `youtu.be/`) shows the video sidebar, anything else shows the webpage sidebar. When the user switches tabs or navigates with the panel open, it follows the active tab (webpage state resets, see part 1).
- The side panel was deleted in phase 27 (new tab became the only surface). This reverses that for the icon only. The new tab is unchanged.
- The user runs the extension in Brave. Brave support for `chrome.sidePanel` is not documented; the extension had a working side panel before phase 27 in the same browser, so it's assumed to work. Verify in Brave first; if it doesn't, stop and ask the user (fallback would be an in-page panel injected by a content script).
- Mic in the side panel: Talk needs the microphone. Side panels can't always show the permission prompt; if the mic is denied there, open an extension page once to grant it (same origin, so the grant carries). Builder confirms which is needed.

## Part 1: webpage sidebar (Listen + Talk it through)

Behaves exactly like the paper reader's Listen and Talk panels (rust/ext/src/pages/reader/listen.rs, talk.rs; core audiobook.rs, voice_agent.rs, voice.rs). Reuse them; don't fork them.

- **Listen**: Haiku narrates the page, not verbatim. Same rules as papers: explains equations, proofs, skips references/boilerplate. Same speech chain: Groq Orpheus (settings.talkVoice), OpenAI gpt-4o-mini-tts takes over on Groq limits, no browser-voice fallback (user rule).
- **Talk it through**: speak (Groq Whisper) or type; Haiku asks, never tells (same as papers; user confirmed).
- **Page text**: the main readable content of the active tab, without nav/footers/sidebars. Extracted by injecting a script (`chrome.scripting`, needs the `scripting` permission; `<all_urls>` host permission already exists). Math: MathJax/KaTeX pages keep the source LaTeX (KaTeX `annotation[encoding="application/x-tex"]`, MathJax `script[type^="math/tex"]` or assistive MathML); substitute it inline so Haiku sees `$...$`, not scrambled glyphs. No screenshots (papers use page images; webpages don't need them).
- **"Pages"**: the existing panels take `page_texts: Vec<String>`. Split the webpage into sections (by headings, capped to a sensible size) and feed those as pages. Listen's per-page image path is PDF-only; it must work without `doc`.
- **No highlighting/scrolling** of the webpage while narrating (narration isn't verbatim).
- **Nothing is saved.** Closing the panel, or navigating/switching tabs, forgets narration and conversation.
- Pages the script can't read (chrome://, Web Store, PDFs in Chrome's viewer, empty extraction): show a plain message.

## Part 2: YouTube sidebar (Gemini takeaways + Talk it through)

Gemini is the brain on YouTube; Haiku isn't used there.

- **Key**: new `geminiKey` setting, entered in Settings next to the Claude/Groq/OpenAI keys. Without it the sidebar says so and links to Settings.
- **Model**: current Gemini Flash model (builder checks the current id). Gemini takes the YouTube URL directly as video input (`file_data.file_uri`), so it sees on-screen slides and code, not just speech.
- **Takeaways**: one Gemini call classifies the video and writes notes in that type's shape. Three types:
  - **Lecture**: Cornell notes. Cue questions (left column), timestamped notes (right), summary at the bottom.
  - **Tutorial**: prerequisites at top, numbered steps each with timestamp, exact commands/code shown on screen, gotchas the presenter mentions.
  - **Educational** (Veritasium/3Blue1Brown style): central question, key ideas in order each with timestamp and the intuition/picture used, a "so what" at the end.
  - Ask Gemini for structured JSON (response schema) so the three layouts render reliably.
  - The type is shown and switchable; switching re-runs Gemini for that type and replaces the saved notes.
  - Every timestamp is clickable and seeks the video (inject into the tab: `document.querySelector('video').currentTime = t`).
  - Generation takes ~20-60 s for long videos; show progress/working state.
- **Saving**: notes are stored per video id and survive closing. Reopening the sidebar on a video with notes shows them instantly with no Gemini call. New storage key (e.g. `videoNotes`: video id -> {title, url, type, notes, createdAt}).
- **Talk it through**: same panel behaviour as papers (Whisper in, Orpheus/OpenAI out, half-duplex, Cut in, typing), but Gemini is the brain, ask-never-tell. Context per turn: the saved notes plus the current playback position (read from the tab), not the full video again. Requires notes to exist first. The voice pipeline currently hardcodes Haiku as the brain; it needs a seam for a second brain.
- **Notes page**: new extension page; a "Notes" link goes next to "Papers" in the new tab footer (rust/ext/src/pages/newtab.rs, `edition-index`). Lists saved videos; clicking one shows its notes on the page itself, with a link to the video. No delete or search for now.
- The video sidebar has no Listen.

## Part 3: your own papers and decks

Today every paper and deck mirrors alphaXiv (decks = alphaXiv folders, moves sync to alphaXiv). Own items never touch alphaXiv.

- **Add a paper** on the Papers page: paste an alphaXiv link, arXiv link (abs or pdf), or any PDF URL, and pick one of your own decks.
- **Metadata**: arXiv/alphaXiv links -> title/authors/year from the arXiv API. Other PDFs -> the PDF's own metadata title, else first-page text. Title/authors are editable afterwards.
- **Create decks** on the Papers page. They show as shelves alongside the alphaXiv shelves.
- **Walled off**: own papers go only into own decks; alphaXiv papers can't go into own decks. No ALPHAXIV_* messages for own items, ever, and the alphaXiv sync must not delete or overwrite them.
- **Reading**: own papers open in the same reader with everything papers get: progress/left-off, Listen, Talk, highlights, claims/doubts, heatmap.
- **Storage**: store the link, not a copy of the PDF. If the host removes it, it won't open.
- **Delete**: own papers and own decks can be deleted; deleting a deck deletes its papers.
- **Not included**: uploading a PDF from disk.
- Paper ids: alphaXiv papers use the arXiv id. Own items need ids that can't collide with alphaXiv ones.
- **Duplicates are refused** (user decision): if the link matches a paper already on any shelf (same `paper_match_key`), adding fails with "Already on your shelf in <deck>." This keeps one reading state per PDF, since the reader keys papers and highlights by URL.

## Notes from review (code facts the builder must handle)

- alphaXiv sync wipes own items today: `pull_library` (rust/ext/src/worker/alphaxiv.rs) overwrites the stored `folders` list, and `merge_library` (rust/core/src/alphaxiv.rs) strips folder membership from papers alphaXiv doesn't return. Both need an explicit own-item guard plus a test.
- The reader looks papers up by PDF URL (`find_paper` / `paper_match_key`), and highlights are keyed by URL (`annotation_doc_key`), not by paper id.
- Haiku prompts are paper-specific (`narrate_system` mentions a page picture, `agent_system`/`turn_prompt`/`paper_document` say "paper"/"page N"). Parameterise them for webpages; the panels' `page`/`on_jump` inputs need sensible webpage equivalents (section index; no-op jump).
- oxichrome doesn't model `side_panel`; add it via rust/ext/manifest.patch.json, plus the `sidePanel` and `scripting` permissions in rust/ext/src/lib.rs.

## Non-goals

- Syncing anything new to alphaXiv.
- Saving webpage narration/conversations.
- Listen on YouTube; answering questions (both Talk modes ask, never tell).
- Notes page delete/search; PDF upload.

## Constraints and house rules

- Read settings via `use_settings()`, never `useStorageValue('settings')`.
- New CSS uses design tokens (designSystem/token lint); default theme is dark `grid`; the user is myopic, so keep text large and contrast AAA.
- No emojis in UI copy.
- Tests per part: Rust unit tests for pure logic (extraction/LaTeX substitution, section splitting, Gemini JSON parsing, id/link parsing, sync not touching own items), e2e via the existing Playwright setup (build:ext -> rust/ext/dist/chromium). Live keys aren't available in CI; mock the network.

## Left to the builder

Exact UI layout of both sidebars and the Notes page, section-size limits, Gemini prompt wording and JSON schema, storage key names, how the side panel detects tab changes, module layout.
