# Second brain: an Obsidian-style vault that replaces Notion

*2026-10-14. Milestone 1 in full; later milestones scoped only. Decided
in two interviews; every choice below was the user's unless marked
"default" (decided by Claude, open to overrule) or "assumption" (unverified
fact, with a test or spike that checks it).*

## Why

Notes are scattered across about 75 top-level Notion pages, 8 databases and
nested class trees. Notion stores them but never brings them back, never shows
how they connect, and needs the app open to search. The user wants four things
from the extension: notes that **resurface** in context, **connections**
between notes, **fast recall**, and the mess **cleaned up** into a structure
they can follow.

This reverses the v22 stance (commit `74ed9ef`, "Cut everything Notion
already does"). The extension becomes the notebook. The comment at
`src/shared/brainDump.ts:11` ("this is not a notebook") changes in the same
commit that ships milestone 1.

## Decisions

| Topic | Decision |
|---|---|
| Source of truth | The vault. Nothing ever writes to Notion. Each Notion area is frozen once it is promoted. The job tracker stays live in Notion until milestone 5. |
| Storage | `.md` files with YAML frontmatter in `My Drive/brain/` on the user's personal Gmail Google Drive (stream mode). |
| Other machine | Windows, through Google Drive for desktop (`G:\My Drive\brain`). |
| Access from Chrome | File System Access API. The Brain page is the only writer in the extension; every other page reads an IndexedDB index. |
| Editing | In the extension: CodeMirror 6 live preview, as in Obsidian. |
| Access from Claude Code | A vault MCP server (stdio, Node, Mac only). |
| Structure | Folders by area, plus MOCs and a `Home.md` map. Links are title-only. Lectures, books, courses and videos are split into atomic concept notes; meetings, projects and research, templates and reference pages stay whole. |
| Import | Done by Claude through the Notion MCP, written via the vault MCP into staging, promoted one area at a time. |
| Scope of import | Knowledge notes, projects and research, and the knowledge pages of the `notes` ("raw brain dump") database. Not personal or life pages, task boards, Housing, HW7 or `Account Informations`. The Links database goes to the extension's bookmarks. The job tracker waits for milestone 5. |
| Graph view | None. Connections show as backlinks and unlinked mentions. |
| Redis | Rejected: a browser cannot speak the Redis protocol. Resuming work and the AI cache travel through local IndexedDB and `.brain/` in the Drive folder. |
| Branch | Work happens on `second-brain`, cut from `main`, and ships to public `main`. The vault path, Firebase config and API keys are all supplied by the user; none of the user's notes enter the repo. |

## Milestones

| # | Milestone | Contents |
|---|---|---|
| **1** | **Vault, import, links** | This spec. |
| 2 | Sync and collaboration | A Yjs CRDT per note; live co-editing, comments, version history and auto-merge across machines over a **bring-your-own Firebase** project (Realtime Database). Off until a user pastes a Firebase config. Replaces milestone 1's three-way merge. |
| 3 | Brain AI | Claude Haiku (`claude-haiku-5-5`) first, Ollama fallback, user-supplied key. Semantic link suggestions, ask-my-notes, cleanup suggestions. Every note may be sent. Results cached in `.brain/ai-cache/` by content hash. The existing reader AI (recap, triage) stays Ollama. |
| 4 | Resurfacing | New-tab note card (spaced, weighted by links), related notes in the reader, highlights into notes, flashcards from notes. |
| 5 | Job tracker | Import the Notion Job tracker (Job Title, Employer, Application URL, Applied On, Comment, Status) and add a table view: sort, filter, inline cell edit, add row. Status keeps Notion's groups: to do, in progress, complete. The Notion follow-up timing that hangs off Applied On must be replaced. Notion is fully retired at the end of this milestone. |
| 6 | Mobile | Not planned. |

Milestones 2 to 5 each get their own spec before work starts.

## Milestone 1 scope

- Vault access, file conventions and the shared logic.
- The vault MCP server.
- The Notion import, pilot area first, plus a one-time handoff of the Links
  database to the extension's bookmarks.
- The Brain page:
  - editor and folder tree
  - backlinks and unlinked mentions
  - quick switcher and search
  - daily notes and tasks
  - rename, move and delete
  - resuming where you left off
  - entry points

### Stop points

Each stop leaves something usable. Before the next stage starts, the stop
is tested and documented in the Brain page's how-to note. No stage depends
on a later one.

| Stop | You have |
|---|---|
| A. After the MCP server and full import | A complete, organized vault that works in Claude Code (through the MCP server) and in Obsidian. The Links handoff file is written. |
| B. After the read-only Brain page | Browse, tree, switcher, search, backlinks, mentions, and PDFs opening in the reader, all inside the extension. Notion Links imported into bookmarks. |
| C. After editing | Full milestone 1. |

### Done when

1. **Speed** (strict, on the user's Mac, through `npm run bench:brain`):
   - the last note shows within 300 ms of a warm page open
   - switcher results in 50 ms
   - search in 150 ms for queries without regex
   - no frame over 16 ms while typing in live preview
2. **Zero loss:**
   - killing Chrome mid-typing loses at most the last 1.5 s
   - no rename or move ever leaves a broken link (property tests)
3. **Import verified:**
   - every in-scope Notion page appears in a coverage report with no
     failures
   - the pilot area is approved
   - the merge logs are reviewed
   - the area map is approved
4. **Manual checklist** passes on Mac and Windows (see Testing).

## Architecture

```
Google Drive  My Drive/brain/   (layout under File conventions)

src/shared/brain/            pure, no I/O, unit and property tested
  frontmatter.ts  links.ts  rename.ts (rename + move)  mentions.ts
  query.ts (Obsidian search parser)  search.ts  blocks.ts (paragraphs, tasks)
  merge3.ts  names.ts (sanitise, NFC, collisions)  plan.ts (plans + journal)

src/pages/brain/   Chrome                 mcp/brain/server.ts   Node, stdio
  vault.ts   File System Access I/O        fs I/O on BRAIN_VAULT
  index.ts   IndexedDB index + cache       in-memory index, rebuilt on start
  Editor.tsx CodeMirror live preview       per-path write lock
  Tree.tsx   folder tree (ARIA tree)       write log, path guards
  Brain.tsx  note, panels, switcher

papers page, newtab, reader: read the IndexedDB index only
```

**Plans, not I/O.** Shared code never touches disk. A rename, move, delete
or promote returns a plan, a list of steps such as write, copy or remove.
Each host runs the plan with its own I/O. Both hosts therefore share one
tested implementation.

**Dependencies.**

- `@codemirror/*` (new): live preview is CodeMirror's decoration system; it
  is what Obsidian uses.
- `@modelcontextprotocol/sdk` and its peer `zod` (new, MCP server only):
  protocol framing and tool schemas.
- `fast-check` (new, dev only): property tests with shrinking.
- Reused: `katex` (math), `esbuild` (bundles the server to one `.mjs`
  file), `vitest`, `playwright`, `axe-core`.
- Not added: a YAML library. Frontmatter is a flat subset we write ourselves,
  parsed by `frontmatter.ts`.

**Manifest changes.**

- Two commands. Defaults are Alt+Shift+B (Brain page) and Alt+Shift+D
  (today's daily note), to be checked against Chrome's reserved keys. One
  of Chrome's four suggested-key slots is used today, by `read-this-page`.
- `omnibox: { keyword: "b" }`: type `b sigmoid` in the address bar to jump to
  a note. This needs no permission.

## File conventions

**Layout.** Folders by area.

```
brain/
  Home.md                         the map: links to every area and topic MOC
  Inbox/                          new notes without a folder
  Concepts/                       every concept note, whatever its source
  School/<Course>/                course MOC, "<Course> – Lecture N", labs, project
  Research/Meetings/  Research/Projects/
  Career/
  Learning/<Source>/              Karpathy/, Goodfellow/, YouTube/ ... (source MOC + per-chapter/video notes)
  Reference/                      templates, guides, source lists (kept whole)
  Topics/                         topic MOCs (the 9 Notion tags: AI & ML, Robotics, ...)
  daily/YYYY-MM-DD.md
  attachments/                    images and PDFs, original names, " 2" suffix on clash
  sources/notion/                 "<Title> (<notion id>).md", Notion's markup exactly as fetched
  .brain/
    staging/<area>/  reports/  trash/<date>/  journal/  devices/<id>.json
    notion-map.json  mcp-log.jsonl  import/bookmarks.json (one-time)
```

- Each in-scope Notion page's area comes from an **area map**, a table
  Claude proposes and the user approves before the pilot.
- The index, search and link resolution ignore `sources/`, `.brain/` and
  `attachments/`.
- Files that are binary, not UTF-8, symlinks, `.DS_Store` or `desktop.ini`
  are ignored.

**Titles and filenames.**

- The filename is the title, and **titles are unique across the whole
  vault, ignoring case**, whatever the folder. Links never contain paths, so
  moving a note between folders changes no link.
- Names are normalised to NFC before comparing; macOS can return decomposed
  accents.
- Characters Windows or Drive reject (`/ \ : * ? " < > |`) are replaced in
  the filename, and the original title goes into `aliases`.
- Names over 255 bytes, or paths over the Windows limit, are cut, given a
  6-character hash suffix, and keep the full title in `aliases`.
- Title clashes are prefixed with the course or source: `DL Class – Lecture
  3`, `DATA 220 – Lecture 3`.

**Frontmatter**, always this flat subset:

```yaml
---
created: 2026-02-11
tags: [concept]
aliases: [Logistic function]
sources: ["[[DL Class – Lecture 3]]", "notion:305a8b0b408d800bbfcac9072e86e85c"]
url: https://arxiv.org/abs/1234.5678     # paper notes only
---
```

- Tags mark the **kind** of note only: `moc`, `concept`, `lecture`,
  `project`, `person`, `meeting`, `paper`, `reference`. Topics are MOCs in
  `Topics/`.
- Unknown fields are kept untouched when a note is saved.

**Body syntax.**

- Links: `[[Title]]`, `[[Title|text]]`, `[[Title#Heading]]`.
- Embeds: `![[file.png]]` and `![[file.pdf]]`, resolved inside
  `attachments/`.
- Tasks: `- [ ]` and `- [x]`.
- Callouts: `> [!note]`.
- Block references (`^id`) are out of scope. The vault also opens in
  Obsidian.

**Daily note.** Created holding only `# Tuesday, 14 October 2026`.

## The import

**Rules for the atomic rewrite.**

| Page kind | Treatment |
|---|---|
| Lectures, courses, books, video notes | Split into concept notes in `Concepts/` plus a source MOC (course or source folder) that keeps the lecture's order and links each concept. |
| Meetings | Kept whole, one note each, `YYYY-MM-DD <who>` in `Research/Meetings/`, linking the concepts and projects they mention. |
| Projects and research | Kept whole in `Research/Projects/` or `Career/`, linking concepts. |
| Templates and reference | Kept whole in `Reference/`. |
| `notes` ("raw brain dump") database | Only pages with real knowledge content, by kind as above. Pure link dumps ("Links to visit") and open-loop pages are skipped and listed in the report. |
| Paper notes | Kept whole, tagged `paper`, with `url:` set to the arXiv or DOI link. |

**Merging concepts.**

- One note per concept, holding everything each source said.
- When sources disagree, both statements stay, each attributed, under a
  `> [!question] Sources disagree` callout. Claude never picks a winner.
- Each concept's `sources` lists every origin.

**Screenshots.** Claude looks at each image and embeds it in the concept
note it illustrates. Images whose subject is unclear stay in the lecture
MOC at their original position.

**Per area:**

1. Fetch the pages through the Notion MCP. Each page is staged verbatim for
   `sources/notion/`.
2. Write notes and MOCs into `.brain/staging/<area>/`. A concept that already
   exists is staged as a merged replacement.
3. Attachments: get signed URLs from the Notion MCP, then
   `stage_attachment` downloads them. Expired URLs are fetched again.
4. Write the reports:
   - `<area>-coverage.md` lists each Notion page, where its content went,
     anything deliberately dropped (empty blocks, dead bookmarks), failures,
     and **the Notion pages now frozen**.
   - `<area>-merges.md` lists, per merged concept, which source gave which
     sentence, and each disagreement.
5. The user reviews the staging folder in the free Obsidian app, used only
   for review.
6. `promote_staging` runs as a journaled plan. Any failure blocks it.

**Order.**

1. Area map, plus a list of untitled and "‣" pages with proposed names.
2. Pilot: Deep Learning Class.
3. The other areas.
4. Links handoff.
5. `Home.md` and the topic MOCs are rebuilt last.

**Links handoff.**

- Claude writes `.brain/import/bookmarks.json` with title, URL, first tag
  and liked flag.
- The Brain page shows "Import N bookmarks from Notion" once. It creates
  groups named after the tags and adds each link through the existing
  `ADD_BOOKMARK_GROUP` and `ADD_BOOKMARK` messages. Liked links get a ★
  prefix.
- After success it deletes the file. Links already bookmarked (same URL) are
  skipped.

## Brain page

1. **Entry points.**
   - A Brain link in the new tab's navigation.
   - Alt+Shift+B, Alt+Shift+D, and the omnibox keyword `b`.
   - Cmd+click a link to open it in a new browser tab.
2. **First run.**
   - An empty state says "Choose a folder for your notes" and opens the
     picker.
   - If the folder is empty, it creates `Home.md`, `Inbox/`, `daily/` and a
     short how-to note.
   - The Options page gets a "Brain" section: the folder in use, change
     folder, reconnect.
3. **Open.**
   - The folder handle is kept in IndexedDB. If Chrome wants permission
     again, one "Reconnect vault" button.
   - The last note renders at once from the IndexedDB content cache, so the
     300 ms budget holds while stream-mode reads are slow.
   - Background reconcile: list the folder recursively, re-read only files
     whose modification time or size changed, and sweep trash older than
     30 days.
4. **Layout.**
   - Left: the folder tree (ARIA tree, collapsible, Inbox count).
   - Centre: one note, with back and forward.
   - Right: backlinks, then unlinked mentions, each mention with a
     one-click "link".
5. **Keys** (taken over only while the Brain page has focus):
   - Cmd+O: switcher. Notes are ranked above daily notes. Typing a title
     that does not exist and pressing Enter creates it in `Inbox/`. Chrome
     reserves Cmd+N, so there is no new-note key.
   - Cmd+[ and Cmd+]: back and forward.
   - Cmd+Shift+M: Move to (fuzzy folder picker).
   - Cmd+Shift+F: search.
   - (Assumption) Chrome lets a page capture all four keys; an e2e test
     checks each one.
6. **Edit.**
   - The buffer goes to IndexedDB 300 ms after each change.
   - The file is written 1.5 s after typing stops, and also on blur, on
     hide and on `pagehide`. There is no Save button.
   - Each save becomes the merge base.
   - Typography: the reader's body face, size and line length; the display
     serif for H1 only; monospace for code. Tokens only, so it passes the
     design lint.
   - Rendering uses the spring motion tokens. Hiding markup never moves the
     line. `prefers-reduced-motion` is respected.
7. **Live preview renders:**
   - KaTeX for `$…$` and `$$…$$`
   - images, pasted or dropped into `attachments/` as `Pasted image
     <timestamp>.png`
   - code blocks with syntax highlighting
   - tables
   - links (`[[` autocomplete creates a missing note in `Inbox/`)
   - callouts
   - **clickable task checkboxes**

   PDF embeds show as a card that opens the file in the extension's PDF
   reader.
8. **External change** (Claude Code, the other machine):
   - The open file's modification time is checked on focus and every 5 s
     while visible.
   - If the buffer equals the base: quiet reload with an "updated" toast.
   - Otherwise `merge3(base, mine, theirs)` runs. A clean merge applies; a
     conflict shows inline with "keep mine" and "keep theirs".
   - (Default) External changes never enter your undo history; Cmd+Z only
     reverts your own edits.
9. **Crash recovery.** A buffered draft that differs from the file is
   restored through the same merge.
10. **Two tabs.** `navigator.locks` gives one tab per note the writer role.
    The other follows read-only and takes over when the writer closes.
11. **Rename and move.**
    - Renaming asks first ("Update 14 links in 9 notes?"), then journals the
      plan: write the new file, rewrite the linking notes, remove the old
      file.
    - Moving only relocates the file; no link changes, because links are
      title-only.
    - A capitalisation-only rename goes through a temporary name.
    - (Assumption) `move()` support on local folder handles is unverified,
      so both use copy then remove.
12. **Delete.** Copy to `.brain/trash/<date>/`, then remove.
13. **Where you left off.**
    - Cursor and scroll position go to IndexedDB.
    - The last note goes to `.brain/devices/<id>.json` on note switch or when
      leaving the page.
    - (Default) The device id is a random UUID in `chrome.storage.local`.
14. **Papers.**
    - A note with `url:` matching a papers-library entry shows an "Open in
      papers" chip.
    - The papers page shows "Notes" on an entry whose URL is in the vault
      index.
    - Matching happens at runtime by normalised URL (`urlNormalize.ts`). No
      ids are stored.

**Index entry:** path, title, aliases, tags, outgoing links, headings,
blocks (paragraphs and list items), tasks with their state, modification
time, size, text. Backlinks are derived from outgoing links.

**Search: Obsidian query syntax.**

- Words (AND), `"phrase"`, `OR`, `( )`, `-exclude`, and `/regex/`.
- `file:`, `path:`, `content:`, `tag:`, `line:( )`, `block:( )`,
  `section:( )`.
- `task:`, `task-todo:`, `task-done:`.
- `match-case:` and `ignore-case:`.

`block:` means "within one paragraph or list item"; it needs no block
references. The parser lives in `query.ts`. Search is a linear scan ranked
title, then heading, then body. `ponytail:` move to an inverted index past
about 5,000 notes or when the budget is missed. Regex queries are outside
the 150 ms budget, and a slow regex is cut off at 2 s with a "partial
results" note.

## Vault MCP server

- **Config:**
  - `BRAIN_VAULT` points at the vault.
  - The server is registered in the repo's `.mcp.json`, with the vault path
    taken from the environment so no personal path is committed.
  - Read tools are allowlisted in `.claude/settings.json`.
- **Start:** scans the vault into memory and removes temporary files left by
  a crash. Before each tool call, it re-checks modification times.
- **Tools:**
  - **Read** (allowlisted, no prompt): `search` (same query syntax),
    `read_note`, `backlinks`, `list_moc`, `list_folder`.
  - **Write** (Claude Code asks every time): `daily_note`, `create_note`
    (defaults to `Inbox/`), `write_note`, `edit_note`, `rename_note`,
    `move_note`, `delete_note`.
  - **Import:** `stage_note` and `stage_attachment` are allowlisted for the
    import session only, in `settings.local.json`. `promote_staging` asks
    every time.
- **Guards:**
  - Writes under `sources/notion/` and `.brain/` are refused, except
    staging and the server's own log, journal and `import/`.
  - `edit_note` fails with "changed since read, re-read first" when the file
    changed after Claude's last read.
  - A per-path lock serialises parallel calls.
  - Writes go to a temporary file that is then renamed into place. Every
    write is logged.

## Error handling

Data-loss paths are handled in full. Each row has a test.

| Failure | Response |
|---|---|
| Crash or power loss mid-write | Chrome: `createWritable()` swaps in the file on `close()` (assumption, checked by crash injection). Node: temporary file, then rename. |
| Folder permission lost | Read-only from the cache, reconnect banner, edits buffered and flushed after reconnecting. |
| Drive offline, or a streamed file not yet downloaded | 5 s read timeout, then the cached copy with an "offline copy" badge; writes buffered and retried. |
| Write fails (disk full, file locked) | Persistent "Not saved, retrying" state; never shows saved falsely; offers an export of the buffer to Downloads. |
| IndexedDB quota exceeded | Buffer kept in memory, banner shown, export offered. |
| Drive conflict copy (`Note (1).md`) or partial sync | Found during reconcile; offered as a three-way merge; never deleted automatically. |
| Clocks differ between machines | Modification times compared for equality only, never for order. |
| Rename, move or promote interrupted | The journal finishes or rolls back the plan on the next start. |
| Rename onto an existing title or alias; move onto a clashing name | Refused, naming the clash. |
| Two tabs, or parallel MCP calls | Web Locks per note; per-path lock in the server. |
| Invalid frontmatter | Opens raw with a warning; title taken from the filename. |
| Broken, empty, unclosed, looping or self link | Parsed without error; unresolved style; clicking creates the note in `Inbox/`. |
| Malformed search query (unclosed paren, bad regex) | Inline error under the search box pointing at the position; no crash, no partial parse. |
| Catastrophic regex | Cut off at 2 s, partial results flagged. |
| Huge note or huge pasted image | Decoration limited to the visible range; images over 20 MB ask first. |
| Daily note across midnight or a timezone change | Date fixed when the note is created; never renamed later. |
| Bookmarks handoff partly fails | Added links are recorded; a retry skips them (by URL); the file is kept until everything is in. |
| MCP write to a guarded path; stale `edit_note` | Refused with the rule or the reason. |
| Notion 429, fetch failure, expired attachment URL | Back off and retry; failures logged; area not promotable until none remain. |
| MCP server crash | Temporary files removed on start; the journal resumes. |

## Testing and CI

The existing jobs in `.github/workflows/ci.yml` are kept: `check` runs
typecheck, `npm test` and the build; `e2e` runs Playwright in Chromium.

| Category | Content | Runs in |
|---|---|---|
| Unit | Frontmatter round-trip is byte-identical; links; rename and move plans; names (NFC, sanitising, length, case); mentions; the query parser (every operator, every error); search ranking; blocks and tasks; merge3; journal replay; URL matching for papers. | `check` |
| Property | `fast-check` with a fixed seed in CI and the seed printed on failure. **Invariants:** after any sequence of create, rename, move, delete and edit, no link is broken and every backlink is symmetric; `parse(serialize(x))` equals `x`; merge3 keeps every non-conflicting edit from both sides and never invents text; replaying a journal after a crash at any step leaves either the start state or the end state; query parse then print gives back an equivalent query. | `check` |
| Concurrency | Brain page and MCP editing one note. Two Brain tabs. Parallel MCP calls. A fake Drive agent in tests that delays copies, makes conflict copies and delivers partial files. Crash injection at every journal step. | `check` (Node on temp folders) and `e2e` |
| Load | Generated vaults of 500, 5,000 and 20,000 notes in nested area folders: index build, tree render, switcher, search (plain and with operators), opening the last note, longest task while typing. CI fails at about 3x the real budgets, following `e2e/load.e2e.ts`; `npm run bench:brain` checks the real budgets locally. | New `e2e/brainLoad.e2e.ts` |
| Regression | Every fixed bug gets a failing test first (CLAUDE.md section V). A **synthetic** fixture vault (areas, LaTeX, images, PDFs, lecture MOCs, merged concepts with a disagreement callout, tasks, clashing titles, accents, emoji, a paper with `url:`) with checked-in expected index and search output. None of the user's notes are in the repo. | `check` |
| Edge cases | Every row of the error-handling table. | Both |
| E2E | The Brain page in real Chromium. The native folder picker cannot be automated, so tests give the page a folder from the browser's private file storage (OPFS), which has the same handle interface. The real `vault.ts` runs against it. Also covered: the bookmarks handoff, the papers chip, the omnibox, and an axe check against `e2e/a11yBaseline.ts`. | `e2e` |
| Manual, before milestone 1 is done | On Mac and Windows: Drive stream-mode reads, a forced conflict copy, the network dropped mid-save, permission revoked mid-session, both shortcuts. | Checklist |

## Build order

Stop points from Milestone 1 scope are marked.

1. **Spike, about 10 minutes.** Can `showDirectoryPicker()` on an extension
   page open, read and write
   `~/Library/CloudStorage/GoogleDrive-…/My Drive/brain`? It is unverified
   whether Chrome allows this folder. Fallback: switch Drive to Mirror mode
   with the folder outside `~/Library`.
2. `src/shared/brain/*`, test first: unit, property and fixture tests.
3. MCP server, plus its concurrency and guard tests; register it.
4. Area map and naming list, approved by the user.
5. Pilot import (Deep Learning Class), review in Obsidian, promote.
6. Remaining areas, then `Home.md` and the topic MOCs, then
   `bookmarks.json`. **Stop A.**
7. Brain page, read-only: vault I/O, index, tree, note view, switcher,
   search, panels, PDFs into the reader, papers chip, entry points,
   onboarding, Options section, bookmarks handoff. **Stop B.**
8. Brain page, editing: editor, autosave, merge, recovery, locks, tasks,
   rename, move, delete, daily notes. Then e2e, load and the manual
   checklist. **Stop C.**

## Out of scope for milestone 1

- Live co-editing, comments, version history and cross-machine auto-merge
  (milestone 2).
- All AI (milestone 3).
- New-tab card, reader strip, highlights and flashcards (milestone 4).
- The job tracker and the table UI (milestone 5).
- Graph view, mobile, block references, note tabs and split panes,
  drag-and-drop in the tree, and the MCP server on Windows.

## Open risks

- The Chrome folder picker under `~/Library/CloudStorage` (spike, step 1).
- Drive stream mode: first reads can be slow or fail offline. The user marks
  `brain/` "Available offline" in Drive.
- The full atomic rewrite with merged concepts edits the user's words across
  hundreds of pages. Mitigated by verbatim sources, coverage reports, merge
  logs, the disagreement rule and the pilot; not eliminated.
- Two writers, the Brain page and the MCP server, with only a three-way
  merge between them until milestone 2.
- Notion stays partly live (unfrozen areas, the job tracker) until milestone
  5, so for a while the source of truth depends on the area.
