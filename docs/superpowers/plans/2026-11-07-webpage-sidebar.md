# Webpage Sidebar Implementation Plan

> **Status (2026-11-10): shipped** (spec Part 1, with the changes noted in the spec's
> status). The boxes below were never ticked.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The toolbar icon opens a side panel that narrates the active webpage (Listen) and talks it through (ask, never tell), reusing the paper reader's panels.

**Architecture:** A hand-written injected script (`page-text.js`, run via `chrome.scripting.executeScript`) returns the page's main content as blocks with math already turned back into LaTeX. Pure Rust in `reader_core::webpage` cuts blocks into sections, which stand in for PDF pages. The reader's `ListenPanel` and `TalkPanel` gain a `Source` (Paper | Webpage) that switches prompt wording and labels; a new side panel page hosts them for the active tab.

**Tech Stack:** Rust/wasm (Leptos 0.8, oxichrome fork), Chrome MV3 `sidePanel` + `scripting`, Playwright e2e via vitest.

**Spec:** docs/superpowers/specs/2026-11-07-sidebars-and-own-papers-design.md (Part 1 + "Shared")

## Global Constraints

- Read settings via `use_settings()`, never `use_storage("settings")`.
- New CSS uses design tokens only (rust/ext/css/designSystem.test.ts lints it); default theme `grid`; text large, AAA contrast.
- No emojis in UI copy.
- Listen: Haiku narrates (not verbatim), explains math, skips boilerplate; Groq Orpheus then OpenAI; no browser-voice fallback.
- Talk: ask, never tell.
- Nothing about a webpage is saved; leaving the page (tab switch, navigation, closing the panel) forgets it.
- No highlighting or scrolling of the webpage.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Pre-commit runs `check:fast` (run `cargo fmt` in `rust/` first).
- Build: `npm run build:ext` (outputs rust/ext/dist/chromium). Rust tests: `npm run test:rust`. e2e: `npm run test:e2e -- e2e/<file>`.

## Review Focus

1. A page with no readable text (chrome://, the Web Store, the extension's own reader, a blank SPA shell): the panel must say so plainly, never spin or throw. Tested in Task 4.
2. Switching tabs or navigating while Listen is playing: audio must stop immediately and the panel must show the new page. Tested in Task 4.
3. A very long page (100k+ chars): sections must stay bounded so a single Haiku call never gets more than `SECTION_MAX_CHARS`. Tested in Task 1.
4. KaTeX/MathJax math must reach Haiku as LaTeX, not doubled (rendered glyphs + source) or scrambled. Tested in Task 3.
5. The paper reader must behave exactly as before (prompts still say "page N of M", picture still sent). Existing e2e/listen.e2e.ts and e2e/talk.e2e.ts pass unchanged in Task 2.

---

### Task 1: Core: `Source`, webpage-aware prompts, sections

**Files:**
- Modify: `rust/core/src/voice_agent.rs` (add `Source`; `agent_system`, `paper_document`, `turn_prompt` take it)
- Modify: `rust/core/src/audiobook.rs` (`narrate_system`, `narrate_prompt` take it)
- Create: `rust/core/src/webpage.rs`; register in `rust/core/src/lib.rs`

**Interfaces:**
- Produces:
  - `voice_agent::Source { Paper, Webpage }` (`Copy, PartialEq, Debug`), with `fn noun(self) -> &'static str` ("paper" | "page") and `fn part(self) -> &'static str` ("page" | "section").
  - `audiobook::narrate_system(title: &str, source: Source) -> String`
  - `audiobook::narrate_prompt(n: u32, count: u32, previous: Option<&str>, source: Source) -> String`
  - `voice_agent::agent_system(title: &str, source: Source) -> String`
  - `voice_agent::paper_document(parts: &[String], source: Source) -> String` (labels `[page N]` / `[section N]`)
  - `voice_agent::turn_prompt(history: &[Turn], n: u32, source: Source) -> String`
  - `webpage::Block { level: u8, text: String }` (`Deserialize`, `Clone`, `Debug`, `PartialEq`; level 0 = body text, 1-6 = heading)
  - `webpage::SECTION_MAX_CHARS: usize = 6_000`
  - `webpage::sections(blocks: &[Block]) -> Vec<String>`

- [ ] **Step 1: Write failing tests**

In `audiobook.rs` tests: keep the existing assertions, passing `Source::Paper`. Add:
```rust
#[test]
fn webpage_narration_reads_latex_not_a_picture() {
    let sys = narrate_system("Agent evaluation", Source::Webpage);
    assert!(sys.contains("web page") && sys.contains("LaTeX"));
    assert!(!sys.contains("picture") && !sys.contains("research paper"));
    assert!(sys.contains("Never read math symbol by symbol") && sys.contains("For a proof"));
    assert!(narrate_prompt(2, 5, None, Source::Webpage).contains("section 2 of 5"));
}
```
In `voice_agent.rs` tests:
```rust
#[test]
fn webpage_talk_is_about_the_page_and_still_never_tells() {
    let sys = agent_system("Notes", Source::Webpage);
    assert!(sys.contains("you never tell") && sys.contains("the page \"Notes\""));
    assert!(paper_document(&["a".into(), "b".into()], Source::Webpage).contains("[section 2]"));
    let p = turn_prompt(&[], 3, Source::Webpage);
    assert!(!p.contains("page 3") && !p.contains("section 3"));
    assert!(turn_prompt(&[], 3, Source::Paper).contains("They are on page 3."));
}
```
In `webpage.rs`:
```rust
fn b(level: u8, text: &str) -> Block { Block { level, text: text.into() } }

#[test]
fn cuts_at_top_level_headings_and_keeps_the_heading() {
    let s = sections(&[b(1, "Title"), b(0, "intro"), b(2, "Method"), b(0, "body"), b(4, "Detail"), b(0, "more")]);
    assert_eq!(s, vec!["Title\nintro", "Method\nbody\nDetail\nmore"]);
}

#[test]
fn bounds_every_section() {
    let para = "x".repeat(1_000);
    let blocks: Vec<Block> = (0..150).map(|_| b(0, &para)).collect();
    let s = sections(&blocks);
    assert!(s.len() >= 25);
    assert!(s.iter().all(|t| t.chars().count() <= SECTION_MAX_CHARS));
    let huge = sections(&[b(0, &"y".repeat(20_000))]);
    assert!(huge.iter().all(|t| t.chars().count() <= SECTION_MAX_CHARS) && huge.len() == 4);
}

#[test]
fn drops_empty_blocks_and_sections() {
    assert!(sections(&[b(2, "  "), b(0, "")]).is_empty());
}
```

- [ ] **Step 2: Run, expect compile failures**

Run: `cd rust && cargo test -q -p reader-core`
Expected: FAIL (`Source`, `webpage` not found; arity mismatches).

- [ ] **Step 3: Implement**

- `Source` in voice_agent.rs. Prompts: for `Webpage`, the same rules with wording swapped. Narration: "one section of the web page \"{title}\"", and in place of the picture/extracted-text sentences: "Math arrives as LaTeX between $ or $$ signs; read it from that, never aloud as symbols." The SKIP rule for webpages: "If the section is only navigation, comments, a reference list or acknowledgements, reply with exactly [SKIP]." Build both variants from shared sentence constants, not two copied paragraphs. `narrate_prompt` says "This is {part} {n} of {count}." and "The previous {part} ended". `turn_prompt` for `Webpage` omits the position sentence (a sidebar has no reading position). Talk system for `Webpage`: "someone reading the page \"{title}\"", and "point to the section to look at".
- `sections`: walk blocks, skip blank `text` after trim; a block with `1 <= level <= 3` starts a new section; append each block's text on its own line; when adding a block would pass `SECTION_MAX_CHARS`, start a new section first; a single block longer than the cap is split into cap-sized char chunks. Drop sections that are empty.
- Update every caller (`rust/ext/src/pages/reader/listen.rs`, `talk.rs`) to pass `Source::Paper` so the crate still builds.

- [ ] **Step 4: Run tests**

Run: `npm run test:rust`
Expected: all pass, clippy clean, fmt clean.

- [ ] **Step 5: Commit**

```bash
git add rust/core rust/ext/src/pages/reader/listen.rs rust/ext/src/pages/reader/talk.rs
git commit -m "Core: webpage-aware narration and talk prompts, section splitter"
```

---

### Task 2: Panels take a `Source`

**Files:**
- Modify: `rust/ext/src/pages/reader/listen.rs`, `rust/ext/src/pages/reader/talk.rs`, `rust/ext/src/pages/reader/mod.rs` (make `listen`, `talk` `pub mod`; pass `source=Source::Paper`, `doc=Some(doc)`, `on_jump=Some(go)`)
- Modify: `rust/ext/src/voice.rs` (make `mic_error` `pub(crate)`, used in Task 4)

**Interfaces:**
- Consumes: Task 1's `Source` and prompt signatures.
- Produces:
  - `ListenPanel(title: Signal<String>, source: Source, doc: Option<StoredValue<JsValue, LocalStorage>>, page_texts: Signal<Option<Vec<String>>>, page: Signal<u32>, on_jump: Option<Callback<u32>>, on_close: Callback<()>)`
  - `TalkPanel(title: Signal<String>, source: Source, page_texts: Signal<Option<Vec<String>>>, page: Signal<u32>, on_close: Callback<()>)`

- [ ] **Step 1: Implement**

- Listen: `doc: None` means no page image (pass `image_jpeg: None`). `on_jump: None` hides the "Turn pages as it reads" checkbox and skips the jump. Labels use `source.part()`/`source.noun()`. For `Webpage`: idle line "Reads the page aloud, explaining the math as it goes."; start button "Read the page" (always from section 1); playing "Reading section N"; done "That's the end of the page."; error when text missing "The page's text isn't ready yet."; heading over narration "Section N". Paper copy is unchanged.
- Talk: lede for `Webpage`: "Say what you think the page is saying. It asks back; it won't explain. It listens when it has finished speaking. Can't talk right now? Type instead." Paper copy unchanged.

- [ ] **Step 2: Verify the reader is unchanged**

Run: `npm run test:rust && npm run build:ext && npm run test:e2e -- e2e/listen.e2e.ts e2e/talk.e2e.ts e2e/reader.e2e.ts`
Expected: all pass with no test edits.

- [ ] **Step 3: Commit**

```bash
git add rust/ext/src
git commit -m "Listen and Talk panels take a source: paper or webpage"
```

---

### Task 3: Read a tab's main text, math as LaTeX

**Files:**
- Create: `rust/ext/js/page-text.js`
- Modify: `scripts/rust-assets.mjs` (copy it to `static/page-text.js`)
- Modify: `rust/ext/src/chrome.rs` (bindings below)
- Create: `rust/ext/src/page_text.rs`; register in `rust/ext/src/lib.rs`; add `"scripting"` to `permissions` there
- Create: `e2e/fixtures/webpage.html`
- Test: `e2e/sidebar.e2e.ts` (the extraction test; Task 4 adds to this file)

**Interfaces:**
- Produces:
  - `page-text.js`: a classic script whose last expression is `{ title: string, blocks: { level: number, text: string }[] }` (the value `executeScript` returns).
  - `chrome::scripting_execute_script(details: &JsValue) -> Result<Promise, JsValue>` (`chrome.scripting.executeScript`).
  - `page_text::PageText { title: String, sections: Vec<String> }`
  - `page_text::read(tab_id: i32) -> Result<PageText, String>` (async). Runs `{ target: { tabId }, files: ["page-text.js"] }`, takes `result[0].result`, deserialises blocks into `reader_core::webpage::Block`, returns `sections(&blocks)`. Errors (injection refused, no result) map to `"This page can't be read here."`; zero sections to `"Couldn't find any text on this page."`.

- [ ] **Step 1: Write the fixture**

`e2e/fixtures/webpage.html`: a `<nav>` with "Home Courses", a `<header>` with "Site banner", `<main>` containing: `<h1>Agent evaluation</h1>`, a paragraph, `<h2>Metrics</h2>`, a paragraph with inline KaTeX (a `span.katex` holding `span.katex-mathml > math > semantics > annotation[encoding="application/x-tex"]` with `p(y \mid x)` plus a `span.katex-html` with glyph spans "p(y∣x)"), a display KaTeX (`span.katex-display` wrapping the same structure, TeX `\sum_i r_i`), a MathJax v2 `<script type="math/tex; mode=display">E = mc^2</script>` preceded by `<span class="MathJax_Preview">E=mc2</span>` and followed by `<span class="MathJax_Display">E=mc2 glyphs</span>`; then `<aside>Related posts</aside>` and `<footer>Copyright</footer>`.

- [ ] **Step 2: Write the failing e2e test**

In `e2e/sidebar.e2e.ts`, serve the fixture via `ext.sites.setRoute('notes', '/agent-evaluation', html(...))`, open it in a tab, then from an extension page run `chrome.scripting.executeScript({ target: { tabId }, files: ['page-text.js'] })` and assert on `result[0].result`:
```ts
const text = r.blocks.map((b) => b.text).join('\n');
expect(r.title).toBe('Agent evaluation');
expect(r.blocks[0]).toEqual({ level: 1, text: 'Agent evaluation' });
expect(text).toContain('$p(y \\mid x)$');
expect(text).toContain('$$\\sum_i r_i$$');
expect(text).toContain('$$E = mc^2$$');
expect(text).not.toMatch(/p\(y∣x\)|E=mc2|Home Courses|Site banner|Related posts|Copyright/);
```

- [ ] **Step 3: Run, expect fail**

Run: `npm run build:ext && npm run test:e2e -- e2e/sidebar.e2e.ts`
Expected: FAIL (file `page-text.js` not found).

- [ ] **Step 4: Implement `page-text.js`**

Root: first of `article`, `main`, `[role=main]`, else `body`; work on a `cloneNode(true)` (never mutate the live page). In the clone, first replace math with text nodes: `.katex-display` -> `$$tex$$`, remaining `.katex` -> `$tex$` (tex from `annotation[encoding="application/x-tex"]`); `script[type^="math/tex"]` -> `$$..$$` if type contains `mode=display` else `$..$`, removing sibling `.MathJax_Preview`, `.MathJax`, `.MathJax_Display`, `.MathJax_SVG*`; MathJax 3 `mjx-container` -> its `math` `alttext` or annotation TeX if present, else its assistive MathML text; bare `math` with x-tex annotation or `alttext` likewise. Then remove `nav, header, footer, aside, script, style, noscript, form, button, svg, [hidden], [aria-hidden="true"]`. Blocks: `h1..h6` (level = digit), and `p, li, pre, blockquote, figcaption, dt, dd, td` (level 0) that do not contain another matched block; text = `textContent` with whitespace collapsed (keep newlines inside `pre`). Title: first `h1` text, else `document.title`. Last line is the object expression.

Then `page_text.rs` per the interface, and the `rust-assets.mjs` copy line.

- [ ] **Step 5: Run, expect pass**

Run: `npm run build:ext && npm run test:e2e -- e2e/sidebar.e2e.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add rust/ext/js/page-text.js scripts/rust-assets.mjs rust/ext/src e2e/fixtures/webpage.html e2e/sidebar.e2e.ts
git commit -m "Read a tab's main text with math as LaTeX"
```

---

### Task 4: The side panel page and the toolbar icon

**Files:**
- Create: `rust/ext/src/pages/sidebar.rs` (register `pub mod sidebar;` in `pages/mod.rs`)
- Create: `rust/ext/css/sidebar.css`
- Modify: `rust/ext/src/chrome.rs` (bindings below)
- Modify: `rust/ext/src/lib.rs` (add `"sidePanel"` permission)
- Modify: `rust/ext/manifest.patch.json` (add `"side_panel": { "default_path": "src/pages/sidebar/index.html" }`)
- Modify: `rust/ext/js/worker.js` (replace the `chrome.action.onClicked` line with `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => console.error('[worker] side panel', e));`)
- Modify: `rust/ext/src/worker/mod.rs` (delete `on_action_clicked`)
- Modify: `e2e/harness.ts` (`PAGES.sidebar = 'src/pages/sidebar/index.html'`)
- Test: `e2e/sidebar.e2e.ts`

**Interfaces:**
- Consumes: `page_text::read`, `ListenPanel`/`TalkPanel` (Task 2 signatures), `voice::mic_error`.
- Produces: page `#[oxichrome::page(path = "src/pages/sidebar/index.html", title = "Reader", css = ["assets/theme.css", "assets/reader.css", "assets/aiNote.css", "assets/markdown.css", "assets/sidebar.css"])]`; query params `?tab=<id>` (pin the target tab: tests) and `?mic=1` (microphone grant mode).
- New bindings: `chrome::tabs_on_activated(listener: &Closure<dyn FnMut(JsValue)>)`, `chrome::tabs_on_updated(listener: &Closure<dyn FnMut(i32, JsValue, JsValue)>)` (`chrome.tabs.onActivated/onUpdated.addListener`).

- [ ] **Step 1: Write failing e2e tests** (in `e2e/sidebar.e2e.ts`, with `mockClaude` and the Groq tone route copied from `e2e/listen.e2e.ts`)

1. `narrates the active page section by section, with LaTeX`: open the fixture tab, open `${PAGES.sidebar}?tab=<id>`; heading shows "Agent evaluation"; click "Read the page"; expect Haiku prompts to include `section 1 of` and the document to include `$p(y \mid x)$` and no request carries an image; Groq receives the narration text; status reaches "That's the end of the page.".
2. `talk asks about the page`: click "Talk it through", type a turn and send; the captured system prompt contains `the page "Agent evaluation"` and `you never tell`.
3. `forgets the page on navigation`: start Listen, then navigate the target tab to a second fixture route (`<h1>Second page</h1><p>Other.</p>`); within 2 s the heading shows "Second page", the panel is back to idle ("Read the page"), and no further Groq request carries first-page narration.
4. `says so on a page it can't read`: `?tab=` pointing at a tab on `chrome://version` (or the extension's own newtab page) shows "This page can't be read here." and no Listen button; a fixture with only `<nav>` shows "Couldn't find any text on this page.".
5. `the toolbar icon opens the side panel`: read `chrome.runtime.getManifest()` from the worker and assert `side_panel.default_path === 'src/pages/sidebar/index.html'`, and `await chrome.sidePanel.getPanelBehavior()` returns `openPanelOnActionClick: true`.
6. axe: `expectA11y(page, 'sidebar')` on the loaded sidebar.

- [ ] **Step 2: Run, expect fail**

Run: `npm run build:ext && npm run test:e2e -- e2e/sidebar.e2e.ts`
Expected: the new tests fail (page missing).

- [ ] **Step 3: Implement the page**

- Target: `?tab=<id>` if present (then follow only that tab's updates), else `tabs.query({ active: true, currentWindow: true })` and re-query on `onActivated`. On `onUpdated` for the target with a `url` change or `status == "complete"`, re-read. State `RwSignal<Option<Target>>` where `Target { tab_id: i32, url: String, text: Result<PageText, String> }`; non-http(s) URLs short-circuit to `Err("This page can't be read here.")` without injecting.
- Render the panels inside `{move || target.get().map(...)}` keyed so a new `(tab_id, url)` unmounts the old panels (their `on_cleanup` stops audio). This is what "forgets the page" means; no storage writes.
- Layout: `<main class="sidebar">`, `<h1>` page title (two lines max, ellipsis), a two-button switch "Listen" / "Talk it through" (`aria-pressed`, Listen by default; switching unmounts the other panel), then the panel with `source=Source::Webpage`, `doc=None`, `on_jump=None`, `page=Signal::stored(1)`, `on_close` a no-op. Under Talk, a line "Mic blocked in the side panel?" with a button "Allow the microphone" that opens `sidebar/index.html?mic=1` in a new tab.
- `?mic=1` mode: on load call `getUserMedia({ audio: true })`, stop the tracks, show "Microphone allowed. Close this tab and press Start talking." or the `mic_error` text.
- `sidebar.css`: single column for a ~320-500px panel; the reader panels' fixed widths/positions are overridden to `position: static; width: auto`. Tokens only.

- [ ] **Step 4: Run, expect pass**

Run: `npm run check`
Expected: everything passes (typecheck, unit, Rust, build, full e2e).

- [ ] **Step 5: Manual check in Brave (user)**

Load `rust/ext/dist/chromium` at brave://extensions (reload). On https://cs2680.seas.harvard.edu/notes/agent-evaluation click the icon: the side panel opens with the page title; Listen narrates and explains the math; Talk with the mic works (use "Allow the microphone" if blocked); switching tabs follows. If the side panel does not open in Brave, stop and report: the fallback (an in-page panel) is a new decision for the user.

- [ ] **Step 6: Commit**

```bash
git add rust/ext e2e
git commit -m "Side panel: Listen and Talk it through for any webpage; the icon opens it"
```
