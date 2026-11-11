# YouTube Sidebar Implementation Plan

> **Status (2026-11-10): shipped** (spec Part 2, with the Notes page). The boxes below
> were never ticked.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a YouTube video the side panel shows Gemini-written takeaways (lecture / tutorial / educational shapes, clickable timestamps, saved per video) and Talk it through with Gemini as the brain (ask, never tell); a Notes page lists saved videos.

**Architecture:** Pure rules in `reader_core::youtube` (video ids, timestamps, the Gemini request body and its JSON schema, parsing, the notes as Talk's document). `rust/ext/src/gemini.rs` does the one fetch. The side panel (`pages/sidebar.rs`, built in part 1) branches on the tab's URL: a video id shows `VideoPanel`, anything else the webpage panels. A shared `NotesView` component draws notes in the panel and on the new Notes page.

**Tech Stack:** Rust/wasm (Leptos 0.8), Gemini `generateContent` REST, Chrome `scripting` (seek, current time), Playwright e2e.

**Spec:** docs/superpowers/specs/2026-11-07-sidebars-and-own-papers-design.md (Part 2)

## Global Constraints

- Gemini is the brain on YouTube; Haiku is not used there. No Listen on videos.
- Model `gemini-3.6-flash` (listed "Stable" on 2026-11-07; verified with the user's key). Endpoint `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent`, header `x-goog-api-key`. JSON output via `generationConfig.responseMimeType = "application/json"` + `responseJsonSchema` (verified; the `responseFormat` shape is not used).
- Video part: `{ "file_data": { "file_uri": "<watch URL>" } }`, placed before the text part. Public videos only (Gemini's rule).
- New setting `geminiKey` (`Settings.gemini_key`, `#[serde(default)]`), entered in Settings next to the other keys.
- Notes stored under storage key `videoNotes`: object keyed by video id. Reopening a video with notes makes no Gemini call. Switching type re-runs Gemini and replaces them.
- Talk on video: ask, never tell; context = saved notes + current playback position (MM:SS), never the video again. Requires notes.
- Notes page: "Notes" link next to "Papers" in the new tab footer; list of saved videos; notes shown on the page with a link to the video. No delete or search.
- Read settings via `use_settings()`. CSS tokens only. No emojis. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. YouTube is a single-page app: moving from one video to the next (or to the home page) must swap the panel to the new video (or the webpage panel) and stop Talk. Tested in Task 3.
2. Gemini failures (no key, private/unavailable video, quota 429, malformed JSON, a 3-hour video over the token limit): a plain message, never a spinner forever, and nothing saved. Tested in Tasks 1 and 3.
3. Timestamps in any of `MM:SS`, `M:SS`, `H:MM:SS`, or junk: seek only on valid ones; junk renders as text. Tested in Task 1.
4. Video URL shapes: `watch?v=`, `youtu.be/`, `/shorts/`, `m.` and `music.` hosts, extra params, `/embed/`; not channel or home pages. Tested in Task 1.
5. Opening the panel while browsing YouTube must not spend a Gemini call by itself (ruling below). Tested in Task 3.

**Ruling (plan):** notes are made when you press "Take notes", not on opening the panel. The panel follows the active tab, so auto-generating would spend a Gemini call on every video you pass through with the panel open. Cost if wrong: one click.

---

### Task 1: Core: video ids, timestamps, the Gemini request and notes

**Files:**
- Create: `rust/core/src/youtube.rs` (register in `lib.rs`)
- Modify: `rust/core/src/types.rs` (`Settings.gemini_key`)
- Modify: `rust/core/src/voice_agent.rs` (`Source::Video`)

**Interfaces (Produces):**
- `youtube::video_id(url: &str) -> Option<String>` (11-char id)
- `youtube::seconds(stamp: &str) -> Option<u32>`; `youtube::stamp(secs: u32) -> String` (`M:SS` under an hour, `H:MM:SS` above)
- `youtube::Kind { Lecture, Tutorial, Educational }` (serde lowercase; `label()` -> "Lecture" | "Tutorial" | "Educational")
- `youtube::VideoNotes { id, url, title, kind: Kind, summary, cues: Vec<Stamped{t,text}>, notes: Vec<Stamped>, prerequisites: Vec<String>, steps: Vec<Step{t,text,code,gotcha}>, question, ideas: Vec<Idea{t,idea,intuition}>, created_at: i64 }` (serde camelCase, every list/str `#[serde(default)]`)
- `youtube::GEMINI_MODEL`, `youtube::gemini_url() -> String`
- `youtube::notes_request(url: &str, kind: Option<Kind>) -> serde_json::Value`
- `youtube::parse_notes(body: &str, id, url, title, now) -> Result<VideoNotes, String>` (reads `candidates[0].content.parts`, the last text part, JSON; maps `error.message`/`promptFeedback.blockReason` to plain words)
- `youtube::gemini_error(status: u16, body: &str) -> String`
- `youtube::notes_document(n: &VideoNotes) -> String` (plain text Talk reads, timestamps kept)
- `youtube::talk_request(system: &str, document: &str, prompt: &str) -> Value` (text-only generateContent body, `systemInstruction`)
- `Source::Video`: `noun()` "video", `part()` "moment"; `agent_system` for Video says "watching the video" and "point to the moment to rewatch"; `turn_prompt(history, secs, Source::Video)` starts "They are at {stamp(secs)} in the video."; `paper_document(&[notes], Source::Video)` returns the notes unlabelled.

- [ ] **Step 1: Failing tests** in `youtube.rs`:
  - `video_ids`: `watch?v=dQw4w9WgXcQ&t=10s`, `youtu.be/dQw4w9WgXcQ?si=x`, `/shorts/dQw4w9WgXcQ`, `m.youtube.com/watch?v=…`, `music.youtube.com/watch?v=…`, `/embed/dQw4w9WgXcQ` all give `dQw4w9WgXcQ`; `youtube.com/`, `youtube.com/@chan`, `watch?v=short`, `example.com/watch?v=dQw4w9WgXcQ` give None.
  - `timestamps`: `seconds("01:15")==75`, `"1:15"==75`, `"1:02:03"==3723`, `"00:00"==0`, `"7:5"`/`"ab"`/`""`/`"1:60"` None; `stamp(75)=="1:15"`, `stamp(3723)=="1:02:03"`.
  - `request_shape`: `notes_request(url, None)` has `contents[0].parts[0].file_data.file_uri == url`, a text part, `generationConfig.responseMimeType == "application/json"`, a `responseJsonSchema` whose `kind` enum is the three kinds; `Some(Kind::Tutorial)` puts "tutorial" in the text and no classification ask.
  - `parsing`: a canned success body (copied shape from the verified call) parses to Tutorial with steps; `{"error":{"code":403,"message":"..."}}` -> Err containing the message; a body with no candidates and `promptFeedback.blockReason` -> Err "Gemini declined…"; non-JSON text part -> Err "Gemini's notes came back unreadable."
  - `gemini_error`: 400 with "API key not valid" -> "The Gemini key in Settings isn't valid."; 429 -> mentions the daily/minute limit; 404/400 with "video" -> "Gemini can't open this video (it may be private or unavailable)."; 400 with "token" -> "This video is too long for Gemini in one go."
  - `notes_document` contains each section's text with stamps; voice_agent test: `turn_prompt(&[], 75, Source::Video)` starts "They are at 1:15 in the video." and `agent_system("T", Source::Video)` contains "you never tell" and "video".
- [ ] **Step 2:** `cargo test -p reader-core` fails to compile. **Step 3:** implement. **Step 4:** `npm run test:rust` green. **Step 5:** commit "Core: YouTube ids, timestamps, Gemini notes request and parsing".

### Task 2: Gemini fetch, the key in Settings, Talk with Gemini

**Files:** Create `rust/ext/src/gemini.rs` (register in lib.rs); modify `pages/options.rs` (TextRow `gemini-key`, label "Gemini API key (YouTube notes)", placeholder "AIza…", hint "Takes notes on YouTube videos and talks them through. Get one at aistudio.google.com."), `pages/reader/talk.rs`.

**Interfaces:** `gemini::generate(key: &str, body: &Value, timeout_ms: i32, controller: Option<AbortController>) -> Result<String, String>` (returns the raw body text on 200, else `youtube::gemini_error`). TalkPanel: when `source == Source::Video`, the reply comes from `gemini::generate(talk_request(..))` (whole reply, then chunked and spoken as one), keys checked are Gemini (+ Groq for voice): messages "Talking needs a Gemini key and a Groq key in Settings." / "Typing needs a Gemini key in Settings.". Paper and Webpage paths unchanged.

- [ ] Test: covered by Task 3's e2e (typed Talk on a video hits the mocked Gemini, never Anthropic). Existing `e2e/talk.e2e.ts` and `e2e/sidebar.e2e.ts` stay green.
- [ ] Commit "Gemini key in Settings; Talk it through can think with Gemini".

### Task 3: Video panel in the side panel

**Files:** Create `rust/ext/src/pages/notes_view.rs` (`NotesView(notes: VideoNotes, on_seek: Option<Callback<u32>>)`: Lecture = two-column cue/notes grid + summary; Tutorial = prerequisites list, ordered steps with `<pre><code>` for code and a "Watch out:" line for gotchas; Educational = question, ordered ideas with intuition, "So what" summary; every stamp is a `<button>` when `on_seek` is Some, else a link `url&t={secs}s`); modify `pages/sidebar.rs`, `css/sidebar.css`; test `e2e/youtube.e2e.ts`.

**Behaviour:**
- `load()`: if `youtube::video_id(url)` is Some, the target is `Video { id, url, title }` (title = tab title minus " - YouTube"); no page text is read.
- `VideoPanel`: notes from `use_storage::<BTreeMap<String, VideoNotes>>("videoNotes")`. None saved: lede "Gemini watches the video and writes takeaways shaped to it: lecture, tutorial or explainer." and a "Take notes" button. Working: "Gemini is watching the video… {n} s" (1 s ticker), Cancel. Saved: kind switch (three `aria-pressed` buttons; pressing another kind re-runs with that kind and replaces), `NotesView` with `on_seek`, then "Listen"-free mode switch "Notes" / "Talk it through". Errors in `role=alert`; no key -> message + button opening Settings.
- Seek: `scripting.executeScript({ target: {tabId}, world: "MAIN", func, args: [secs] })` with `func = js_sys::Function::new_with_args("t", "const v=document.querySelector('video'); if (v) { v.currentTime = t; v.play(); }")`.
- Talk: `TalkPanel source=Source::Video page_texts=Some(vec![notes_document(n)]) page=<seconds signal>`; the seconds signal is refreshed every 2 s while Talk is shown via executeScript returning `document.querySelector('video')?.currentTime`.
- SPA: part 1's `moved` handling already rebuilds on URL change; video ids differ, so the panel swaps.

- [ ] **Step 1: Failing e2e** (`ctx.route('https://www.youtube.com/watch**')` serves a fixture page with `<video>` (a generated silent webm or just a `<video>` whose `currentTime` is settable) and title "Some talk - YouTube"; Gemini mocked via `ctx.route('https://generativelanguage.googleapis.com/**')` recording bodies):
  1. opening the panel on a video makes no Gemini call; pressing "Take notes" makes one whose body has `file_data.file_uri` = the watch URL; the tutorial notes render (steps, code block); `videoNotes` holds them.
  2. reopening the panel on that video shows notes with zero new Gemini calls.
  3. clicking a step's timestamp sets the page's `video.currentTime` to its seconds.
  4. switching to "Lecture" re-runs with "lecture" in the request text and replaces the stored kind.
  5. Gemini 403 "API key not valid" -> "The Gemini key in Settings isn't valid." and nothing stored; no key -> the Settings message and no call.
  6. Talk typed turn on the video: request goes to Gemini (none to Anthropic), its prompt has "They are at 0:42 in the video." after setting `currentTime = 42`, its system has "you never tell".
  7. navigating the tab (`history.pushState` to another `watch?v=`) swaps to that video's empty state; to `youtube.com/` shows the webpage panel.
  8. axe clean on the video panel.
- [ ] **Step 2:** run, fail. **Step 3:** implement. **Step 4:** `npm run check` green. **Step 5:** commit "Side panel: Gemini takeaways and Talk it through on YouTube".

### Task 4: Notes page

**Files:** Create `rust/ext/src/pages/notes.rs` (`#[oxichrome::page(path = "src/pages/notes/index.html", title = "Notes", css = ["assets/theme.css", "assets/notes.css", "assets/sidebar.css"])]`), `rust/ext/css/notes.css`; modify `pages/mod.rs`, `pages/newtab.rs` footer (`<a class="edition-link" href=chrome::get_url(NOTES_PAGE_PATH)>"Notes"</a>` after Papers), `rust/core/src/constants.rs` (`NOTES_PAGE_PATH`), `e2e/harness.ts` (`PAGES.notes`).

**Behaviour:** list (newest first) of saved videos: title, kind, date; selecting one (also via `#<id>`) shows `NotesView` with `on_seek=None` (stamps are links to the video at that time) and "Watch on YouTube". Empty: "No notes yet. Open a YouTube video, click the Reader icon, and press Take notes."

- [ ] e2e: seeded `videoNotes` with two videos -> list order, clicking shows notes, a stamp link is `https://www.youtube.com/watch?v=ID&t=75s`, footer link present on the new tab, axe clean, empty state.
- [ ] Commit "Notes page for saved video takeaways".
