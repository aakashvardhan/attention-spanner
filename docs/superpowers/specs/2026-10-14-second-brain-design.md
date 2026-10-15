# Second brain: an Obsidian-style vault that replaces Notion

*2026-10-14. Milestone 1 in full; later milestones scoped only. Decided
in three interviews, the third after reverse engineering Obsidian and Notion
(see "What we took from Obsidian and Notion", which also covers Gloss).
Every choice below was the user's unless marked "default" (decided by
Claude, open to overrule) or "assumption" (unverified fact, with a test or
spike that checks it).*

*Revised the same day to be evidence-led, not larger. Success is measured
against a Notion baseline (Outcomes), each claim is checked against the
rawest source available (Ground truth), and every part is judged by
something other than Claude or the user (Oracles).*

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

## Outcomes

The four goals are measured, with a baseline taken in Notion before any
code is written (build order step 0). Questions, raw data and results live
in `.brain/reports/` in the vault, never in the repo.

| Goal | Measure | Baseline | Target |
|---|---|---|---|
| Fast recall | The **recall benchmark**: 25 questions the user actually needed answered from their notes in the last six months, written by the user (helped by the usage counts below) and frozen before the import. Success means the right note is open within 60 s; the time is recorded. Claude does not see the questions until the import is done, so the import cannot be tuned to them. **Declined by the user on 2026-10-15**, so there is no Notion baseline. | Not taken. | Fast recall rests on the search and switcher speed budgets in Done when, and on the tree test. |
| Connections | The share of in-scope notes with at least one link in and one link out, and the count of unresolved links, **as Obsidian reports them**. | The same share for the in-scope Notion pages, from page mentions, link-to-page blocks and relations in `notion.db`. | Higher than Notion; zero unresolved links. |
| Cleanup (a structure the user can follow) | A **tree test**: 15 "where would you find…" tasks answered by browsing folder names only, scored on success and directness (first path taken was right). | Run on the proposed area map, before the pilot. | (Default) 80% success and 70% directness: on the map before the pilot, and again on the real vault at stop B. A failed task changes the map, and the test is run again. |
| Resurfacing (milestone 4; only the baseline now) | Notes older than 30 days opened per week. | Chrome's visit history to notion.so pages, reduced to counts per page id per week. | Set in milestone 4's spec against this baseline. From stop B the Brain page counts note opens per day per device in IndexedDB, so the number exists when milestone 4 starts. |

## Ground truth

Each claim this spec rests on is checked against the rawest source
available, not against a summary of it, including Claude's summaries
elsewhere in this document.

| Question | Raw source | Not |
|---|---|---|
| What the Notion content says | Notion's own workspace export (HTML), made by the user from Notion's settings, kept in a local folder outside the vault and never committed. The block records in `notion.db` are a cross-check. | The Notion MCP's converted Markdown, which is what the import itself reads. |
| What the user actually uses | Chrome's History database, a copy queried read-only with the user's go-ahead, reduced to visit counts per Notion page id; every other URL is discarded. Also Notion's own visit records where the cache has them, and the extension's reading and annotation data. | Interview answers about use. |
| Can Chrome pick and write the Drive folder | Chromium's blocked-path list in its File System Access permission code and its swap-file (`.crswap`) write path, for the installed Chrome version; then the step 1 harness. | A guess, or a 10-minute spike. |
| How Drive for desktop behaves | Measured on both machines by the step 1 harness: the sync delay from Mac to Windows, whether modification times survive, conflict-copy names when both sides edit offline, what reading an online-only file through a folder handle does, and how a rename arrives on the other side. | Drive's help pages. |
| How Obsidian resolves links, headings, tags and properties | Obsidian itself, running on the vault, through `app.metadataCache` in its developer console, and its published typings (the `obsidian` npm package). | Claude's reading of its minified bundle. |
| Markdown and YAML rules | The CommonMark and GFM specs' example suites, and the YAML test suite for the frontmatter subset. | Recollection. |
| Review scheduling (milestone 4) | The FSRS model, and the user's own logged review outcomes. | Gloss's hand-picked intervals alone. |

## Oracles

Something other than Claude or the user decides whether each part is
right. Each stop's gate is the rows that apply to it.

| Claim | Judge | Pass |
|---|---|---|
| The import kept the content | `npm run brain:audit` against Notion's export, and a blind sample the user rates (see Fidelity audit) | Every invariant accounted for; no lost or distorted passage in the sample. |
| The vault is valid Obsidian | Obsidian's metadata cache, dumped and diffed against our index (`npm run brain:diff-obsidian`) | Zero unresolved links; the same resolved links, headings and tags per file; each difference is fixed or listed as a deliberate deviation. Runs on the real vault at stop A, and in CI against a checked-in dump of the fixture vault with the Obsidian version recorded. |
| Our parsers read Markdown and YAML correctly | Differential tests: `blocks.ts` and `tables.ts` against the CommonMark and GFM specs' own expected output for their examples; `frontmatter.ts` against `yaml` | The same result on every example inside the subset; anything outside it is refused, never misread. |
| Saves survive crashes | The file system under fault injection: a crash at every step of every journaled plan, and `npm run brain:crash` killing Chrome with `kill -9` 1,000 times mid-typing on a copy of the real Drive folder | The file always equals, byte for byte, a version that was saved; recovery loses at most 1.5 s. |
| Concurrent writers never lose an edit | fast-check model-based tests (`fc.commands`) of Brain page tabs and MCP calls against a reference model of the vault | No sequence diverges from the model, except merges that a snapshot records. |
| Typing stays smooth | Chrome's Long Animation Frames API and DevTools traces on the user's Mac | The speed budgets in Done when. |
| The pages are accessible | axe, plus a VoiceOver pass against WCAG 2.2 AA | Nothing beyond `e2e/a11yBaseline.ts`; every Brain page action reachable by keyboard and announced. |
| The brain beats Notion for this user | The tree test and link measure (the recall benchmark was declined) | The targets in Outcomes. |

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
| Graph view | None. Connections show as backlinks, unlinked mentions, hover previews and note embeds. |
| External edits | Obsidian's way: snapshot, then auto-merge your unsaved edits onto the disk version, then a notice. No conflict UI. |
| History | Obsidian's file recovery: local snapshots every 5 minutes, kept 7 days, plus the MCP server's pre-write copies in `.brain/history/`. |
| Databases | Rows become notes with typed properties; each Notion database becomes an Obsidian Bases `.base` file, so Obsidian renders the views today and milestone 5 reads the same files. |
| Editor extras | From Notion: slash menu, block moves, table grid, properties panel. From Obsidian: hover preview, note embeds, outline, starred notes, templates. A `>` command mode in the switcher. All in stop D. |
| Redis | Rejected: a browser cannot speak the Redis protocol. Resuming work and the AI cache travel through local IndexedDB and `.brain/` in the Drive folder. |
| Branch | Work happens on `second-brain`, cut from `main`, and ships to public `main`. The vault path, Firebase config and API keys are all supplied by the user; none of the user's notes enter the repo. |

## Milestones

| # | Milestone | Contents |
|---|---|---|
| **1** | **Vault, import, links** | This spec. |
| 2 | Sync and collaboration | A Yjs CRDT per note; live co-editing, comments, version history and auto-merge across machines over a **bring-your-own Firebase** project (Realtime Database). Off until a user pastes a Firebase config. Replaces milestone 1's auto-merge. Version history gains cross-device sync. |
| 3 | Brain AI | Claude Haiku (`claude-haiku-5-5`) first, Ollama fallback, user-supplied key. Semantic link suggestions, ask-my-notes, cleanup suggestions. Every note may be sent. Ask-my-notes puts the notes it sends in a prompt-cached system message and cites them as `[[Note#Heading]]`, clickable in the Brain page and valid in Obsidian; it may cite only notes it was sent (Gloss's rule for paragraphs). Results cached in `.brain/ai-cache/` by content hash. The existing reader AI (recap, triage) stays Ollama. |
| 4 | Resurfacing | New-tab note card, related notes in the reader, highlights into notes, flashcards from notes. **Daily review** on Gloss's schedule: 5 a day, a kept item returns after 3, 7, 16, 35, 75, then 160 days, "done" retires it; every review outcome is logged to `.brain/review-log.jsonl` so FSRS (`ts-fsrs`) can be fitted to the user's own outcomes and compared with the fixed steps, and switching needs the user's yes; it draws on reader highlights (state on the annotation) and vault notes weighted by links (state in `.brain/review.json`, keyed by title, so reviewing never rewrites a note; renames update it). **Highlights into notes**: one note per text, `Learning/Reading/<Title>.md`, tagged `reference`, with `url` (matched to the papers library like paper notes), highlights as blockquotes in reading order with your sticky note under each. The reader owns only the section between `<!-- reader:start -->` and `<!-- reader:end -->` and regenerates it; text outside the markers is never touched. |
| 5 | Job tracker and views | Import the Notion Job tracker (Job Title, Employer, Application URL, Applied On, Comment, Status) as a `.base` plus row notes, and render `.base` files in the extension: table (sort, filter, inline cell edit, add row), then real board and calendar layouts for the views milestone 1 imported as grouped and sorted tables. Status keeps Notion's groups: to do, in progress, complete. The Notion follow-up timing that hangs off Applied On must be replaced. Notion is fully retired at the end of this milestone. |
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
  - auto-merge and version history
  - resuming where you left off
  - entry points
  - editor extras: slash menu, block moves, table grid, properties panel,
    hover preview, note embeds, outline, starred notes, templates, `>`
    commands
  - `.base` files listed as rows

### Stop points

Each stop leaves something usable. Before the next stage starts, the stop
is tested, passes its judges in Oracles, and is documented in the Brain
page's how-to note. No stage depends
on a later one.

| Stop | You have |
|---|---|
| A. After the MCP server and full import | A complete, organized vault that works in Claude Code (through the MCP server) and in Obsidian. The Links handoff file is written. |
| B. After the read-only Brain page | Browse, tree, switcher, search, backlinks, mentions, and PDFs opening in the reader, all inside the extension. Notion Links imported into bookmarks. `.base` files listed as rows. |
| C. After core editing | Writing moves off Notion: editor, autosave, auto-merge, history, crash recovery, tasks, rename (notes and headings), move, delete, daily notes. |
| D. After the editor extras | Full milestone 1: slash menu, block moves, table grid, properties panel, hover preview, note embeds, outline, starred notes, templates, `>` commands. |

### Done when

1. **Speed** (strict, on the user's Mac, through `npm run bench:brain`):
   - the last note shows within 300 ms of a warm page open
   - switcher results in 50 ms
   - search in 150 ms for queries without regex
   - no frame over 16 ms while typing in live preview, including in a
     table grid and next to embeds
   - (Default) a hover preview shows within 100 ms, from the index cache
2. **Zero loss:**
   - killing Chrome mid-typing loses at most the last 1.5 s
   - no rename or move of a note or heading ever leaves a broken link,
     including links in properties and embeds (property tests)
   - every auto-merge, failed save and Claude write is preceded by a
     snapshot that restores the previous text
3. **Import verified:**
   - every area passes its fidelity audit (invariants and blind sample)
   - Obsidian reports zero unresolved links and agrees with our index
   - every in-scope Notion page appears in a coverage report with no
     failures
   - the pilot area and the merge logs are approved, and so is the area
     map, after its tree test
4. **Manual checklist** passes on Mac and Windows (see Testing).
5. **Outcomes:** the tree test and link targets in Outcomes are met.
   The recall benchmark was declined on 2026-10-15.

## Architecture

```
Google Drive  My Drive/brain/   (layout under File conventions)

src/shared/brain/            pure, no I/O, unit and property tested
  frontmatter.ts  links.ts  rename.ts (rename + move)  mentions.ts
  query.ts (Obsidian search parser)  search.ts  blocks.ts (paragraphs, tasks)
  merge.ts (auto-merge)  names.ts (sanitise, NFC, collisions)  plan.ts (plans + journal)
  properties.ts (typed values, types.json)  base.ts (.base subset: parse, filter, sort)
  tables.ts (markdown table <-> grid)  templates.ts ({{date}} {{time}} {{title}})

src/pages/brain/   Chrome                 mcp/brain/server.ts   Node, stdio
  vault.ts   File System Access I/O        fs I/O on BRAIN_VAULT
  index.ts   IndexedDB index + cache       in-memory index, rebuilt on start
  history.ts IndexedDB snapshots           pre-write copy to .brain/history/
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
- `diff-match-patch` (new, about 20 KB): the auto-merge and the history
  diff view. It is what Obsidian ships for both (observed in its bundle), so
  the merge behaves as it does there.
- `yaml` (new, no dependencies): `.base` files are nested YAML that Obsidian
  may rewrite in any style, so the flat parser cannot read them. Used for
  `.base` only.
- Reused: `katex` (math), `esbuild` (bundles the server to one `.mjs`
  file), `vitest`, `playwright`, `axe-core`.
- Frontmatter stays a flat subset we write ourselves, parsed by
  `frontmatter.ts`, because saves must round-trip byte for byte.

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
  Reference/                      guides, source lists (kept whole)
  Reference/Templates/            templates for the Insert template command
  Topics/                         topic MOCs (the 9 Notion tags: AI & ML, Robotics, ...)
  <area>/<Database>/ + <area>/<Database>.base   row notes and their views
  daily/YYYY-MM-DD.md
  attachments/                    images and PDFs, original names, " 2" suffix on clash
  sources/notion/                 "<Title> (<notion id>).md", Notion's markup exactly as fetched
  .brain/
    staging/<area>/  reports/  trash/<date>/  journal/  devices/<id>.json
    history/<date>/  (MCP pre-write copies, 7 days)
    starred.json  types.json
    notion-map.json  mcp-log.jsonl  import/bookmarks.json (one-time)
```

- Each in-scope Notion page's area comes from an **area map** built from
  the user's own grouping, not Claude's proposal:
  1. An open card sort: the user groups and names about 40 representative
     page titles.
  2. Claude drafts the map from those groups.
  3. The tree test in Outcomes checks the draft.

  The user approves the map before the pilot.
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
- **Typed properties** (database rows and anything the properties panel
  edits). Values stay flat: no nested maps. The types are Obsidian's: text,
  list, number, checkbox, date (`2026-02-11`), datetime
  (`2026-02-11T09:30`). A property's type is stored once for the vault in
  `.brain/types.json`; a property not listed there is typed from its first
  value. Links inside properties (`"[[Employer X]]"`) are real links:
  backlinks include them and renames rewrite them.
- **Starred notes** live in `.brain/starred.json`, an ordered list of
  titles. A rename updates the entry.

**Body syntax.**

- Links: `[[Title]]`, `[[Title|text]]`, `[[Title#Heading]]`.
- Embeds: `![[file.png]]` and `![[file.pdf]]`, resolved inside
  `attachments/`. Note embeds: `![[Title]]` and `![[Title#Heading]]` show
  that note, or that heading's section, inline and read-only.
- Tasks: `- [ ]` and `- [x]`.
- Callouts: `> [!note]`, collapsible as `> [!note]-` (closed) and
  `> [!note]+` (open). Notion toggles become collapsible callouts.
- Block references (`^id`) are out of scope. The vault also opens in
  Obsidian.

**Daily note.** Created holding only `# Wednesday, 14 October 2026`.

## The import

**Rules for the atomic rewrite.**

| Page kind | Treatment |
|---|---|
| Lectures, courses, books, video notes | Split into concept notes in `Concepts/` plus a source MOC (course or source folder) that keeps the lecture's order and links each concept. |
| Meetings | Kept whole, one note each, `YYYY-MM-DD <who>` in `Research/Meetings/`, linking the concepts and projects they mention. |
| Projects and research | Kept whole in `Research/Projects/` or `Career/`, linking concepts. |
| Templates and reference | Kept whole: templates in `Reference/Templates/`, the rest in `Reference/`. |
| `notes` ("raw brain dump") database | Only pages with real knowledge content, by kind as above. Pure link dumps ("Links to visit") and open-loop pages are skipped and listed in the report. |
| Paper notes | Kept whole, tagged `paper`, with `url:` set to the arXiv or DOI link. |
| Meeting transcriptions (28 Notion AI blocks) | The meeting note keeps Notion's summary and the user's notes; the full transcript goes in a closed `> [!quote]- Transcript` callout at the end. |
| Databases in scope (inline or full page) | Each row becomes a note in `<area>/<Database>/` with typed properties; the database becomes `<area>/<Database>.base` holding every Notion view of it. The `notes` ("raw brain dump") database is the exception: its kept pages are filed by kind and it gets no `.base`. |

**Block mapping** (from the block types found in the user's Notion cache).

| Notion block | Becomes |
|---|---|
| Text, headings, bulleted and numbered lists, quote, divider, code, equation, image, file, PDF, video | The matching markdown; files into `attachments/`. |
| To-do | `- [ ]` / `- [x]`. |
| Simple table | A markdown table; the first row becomes the header row. Line breaks inside a cell become `<br>`. |
| Toggle | A closed collapsible callout. |
| Callout | `> [!note]`, or the callout type closest to its icon. |
| Link to page, page mention | `[[Title]]`. |
| Bookmark, embed, external object | A markdown link with the page title. |
| Columns | Flattened into one column, left to right; listed in the coverage report. |
| Button, table of contents, synced-block copy indicator | Dropped; listed in the coverage report. |

**Database properties.**

| Notion property | Frontmatter |
|---|---|
| Title | The filename. |
| Text, URL, email, phone, select, status, person | text |
| Multi-select | list (in its own property, never `tags`) |
| Number | number |
| Checkbox | checkbox |
| Date | date, or datetime when it has a time; a range becomes two properties, `<name>` and `<name> end`. |
| Relation | list of `"[[Title]]"` links |
| Created time, last edited time | `created` (date), the other dropped |
| Files | list of `"[[attachments/…]]"` embeds |
| Rollup, formula, created by, last edited by, last visited | Dropped; listed in the coverage report. A rollup or formula with a direct Bases equivalent becomes a formula in the `.base`. |

**Database views.**

| Notion view | `.base` view |
|---|---|
| Table | `table`, same column order, sort and filter |
| List | `list` |
| Gallery | `cards` |
| Board | `table` grouped by the board's column property |
| Calendar | `table` sorted by its date property |

Filters are written only with `file.inFolder`, `file.hasTag`,
`file.hasLink`, `file.hasProperty` and plain property comparisons (all
observed in Obsidian 1.13's Bases code), so the extension's subset reader
understands every `.base` the import writes.

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
6. The fidelity audit runs. An area is promotable only when it passes.
7. `promote_staging` runs as a journaled plan. Any failure blocks it.

**Fidelity audit.** The rewrite changes the user's words, so it cannot be
judged by Claude's own coverage report.

- **Reference:** Notion's export of the area (see Ground truth),
  independent of the Notion MCP path the import used.
- **Invariants,** checked by `npm run brain:audit` (a Node script in
  `mcp/brain/`). Each of these in the export must appear in the vault, or
  in the coverage report's drop list with a reason:
  - every URL
  - every equation, by its LaTeX source
  - every code block, with whitespace normalised
  - every number inside a sentence
  - every image, by the SHA-256 of its bytes
- **Sentence map:** the script splits the export into sentences
  (`Intl.Segmenter`, NFC) and records, for each, the vault sentence it
  overlaps most and the overlap score. The score is reported and used to
  pick the sample. It is never a pass mark, because the rewrite is meant
  to change words.
- **Blind sample:** a seeded script, not Claude, draws the passages: 30
  from the pilot and 60 from the other areas. Half are drawn uniformly at
  random and half from the lowest overlap scores. The user sees each source
  passage next to where it went, without Claude's notes, and marks it
  kept, lost or distorted.
- **Acceptance:** zero defects in the sample.
  - By the rule of three, zero defects bounds the defect rate below 10% at
    95% confidence for 30 passages, and below 5% for 60.
  - Any defect means: fix the rule that caused it, rerun the area, and
    draw a fresh sample.

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
   - Left: Starred (drag to reorder, star from the note's menu or the
     `>` commands), then the folder tree (ARIA tree, collapsible, Inbox
     count).
   - Centre: one note, with back and forward.
   - Right: outline (the note's headings, click to jump), backlinks, then
     unlinked mentions, each mention with a one-click "link".
5. **Keys** (taken over only while the Brain page has focus):
   - Cmd+O: switcher. Notes are ranked above daily notes. Typing a title
     that does not exist and pressing Enter creates it in `Inbox/`. Chrome
     reserves Cmd+N, so there is no new-note key.
   - `>` as the first character turns the switcher into the command list,
     as in VS Code: every action on the page (rename, move, delete, star,
     daily note, history, insert template, toggle panels, reconnect vault)
     with its key shown.
   - Cmd+[ and Cmd+]: back and forward.
   - Cmd+Shift+M: Move to (fuzzy folder picker).
   - Cmd+Shift+F: search.
   - Alt+Up and Alt+Down: move the current paragraph, list item (with its
     children) or table row.
   - Cmd held while hovering a link: hover preview.
   - (Assumption) Chrome lets a page capture all of these; an e2e test
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
   - callouts, collapsible ones folding with the spring tokens
   - **clickable task checkboxes**
   - note embeds, read-only, with an "open" link. (Default) Nesting stops
     at 3 levels, and an embed that loops back shows as a plain link.

   PDF embeds show as a card that opens the file in the extension's PDF
   reader.
8. **External change** (Claude Code, the other machine). This is the
   behaviour observed in Obsidian 1.13.
   - The open file's modification time is checked on focus and every 5 s
     while visible.
   - If the buffer equals the base: quiet reload with an "updated" toast.
   - Otherwise: snapshot the buffer, then `merge(base, mine, theirs)`,
     which turns your edits since the base into a patch and applies it,
     fuzzily, to the disk version. A notice says "Changed on disk; your
     edits were merged" with a "View history" link. There is no conflict
     UI; a bad merge is undone from history.
   - (Default) External changes never enter your undo history; Cmd+Z only
     reverts your own edits.
9. **Crash recovery.** A buffered draft that differs from the file is
   restored through the same merge, after a snapshot.
10. **Version history.** This follows Obsidian's file recovery.
    - A snapshot of each changed note every 5 minutes, kept 7 days, in
      IndexedDB on this device. A snapshot is also taken before every
      merge, every failed save and every reload caused by an external
      change.
    - The MCP server copies a file into `.brain/history/<date>/` before it
      changes or deletes it, kept 7 days. These show on both machines.
    - The History panel (a `>` command, and the link in the merge notice)
      lists both kinds, newest first. It shows a line diff with changed
      words highlighted and unchanged runs folded, and has a Restore
      button. A restore is itself an edit, so it can be undone.
11. **Two tabs.** `navigator.locks` gives one tab per note the writer role.
    The other follows read-only and takes over when the writer closes.
12. **Rename and move.**
    - Renaming asks first ("Update 14 links in 9 notes?"), then journals the
      plan: write the new file, rewrite the linking notes (body links,
      embeds, links in properties, `.brain/starred.json`), remove the old
      file.
    - Editing a heading that other notes link to or embed asks the same
      question when the cursor leaves the heading line, and rewrites
      `[[Title#Heading]]` and `![[Title#Heading]]` through the same plan.
    - Moving only relocates the file; no link changes, because links are
      title-only.
    - A capitalisation-only rename goes through a temporary name.
    - (Assumption) `move()` support on local folder handles is unverified,
      so both use copy then remove.
13. **Delete.** Copy to `.brain/trash/<date>/`, then remove.
14. **Where you left off.**
    - Cursor and scroll position go to IndexedDB.
    - The last note goes to `.brain/devices/<id>.json` on note switch or when
      leaving the page.
    - (Default) The device id is a random UUID in `chrome.storage.local`.
15. **Papers.**
    - A note with `url:` matching a papers-library entry shows an "Open in
      papers" chip.
    - The papers page shows "Notes" on an entry whose URL is in the vault
      index.
    - Matching happens at runtime by normalised URL (`urlNormalize.ts`). No
      ids are stored.
16. **`.base` files** (stop B).
    - Opening one lists its rows as note links, using its filters, sort
      and grouping (first view, with a view picker), plus "Open in
      Obsidian" (`obsidian://open`) for the full view.
    - `base.ts` reads the subset the import writes. A `.base` that uses
      anything else (formulas, other functions) lists every row with a
      note saying the filter was not applied. It never errors.
    - The extension does not edit `.base` files in milestone 1.

**Editor extras** (stop D). The stop C diary sets their order and
confirms each is needed (Build order step 9).

- **Slash menu.** `/` at the start of a line or after a space opens a menu:
  heading 1 to 3, to-do, bulleted and numbered list, callout, collapsible
  callout, quote, code block, math block, table, divider, image, link,
  embed note, template. It inserts plain markdown. Escape, or a space
  straight after `/`, types a literal slash.
- **Block moves.** Alt+Up and Alt+Down, and a drag handle shown on hover in
  the left margin, move a paragraph, a list item with its children, or a
  table row. Undo restores the order.
- **Table grid.** In live preview a table is edited as a grid: Tab and
  Shift+Tab move between cells, Enter goes down a row, and a menu adds or
  removes rows and columns and sets alignment. Columns are padded only
  where you edit, so untouched rows keep their exact bytes. Raw markdown
  shows while the cursor is on the delimiter row.
- **Properties panel.** The frontmatter shows as a form at the top of the
  note: date picker, checkbox, number field, list chips, and `[[` link
  autocomplete in text and list values. "Add property" offers the names in
  use. A raw YAML toggle is always there. Frontmatter outside the flat
  subset shows raw, read-only, with a warning.
- **Hover preview.** Hold Cmd over a link to see the target note, or its
  heading's section, in a popover rendered from the index cache. Moving
  into the popover keeps it open; clicking opens the note.
- **Templates.** "Insert template" (from the slash menu or the `>`
  commands) lists `Reference/Templates/` and inserts the chosen note at the
  cursor, filling `{{date}}`, `{{time}}` and `{{title}}` the way
  Obsidian's Templates plugin does, so the same templates work there.

**Index entry:** path, title, aliases, tags, typed properties, outgoing
links (body, embeds and properties), headings, blocks (paragraphs and list
items), tasks with their state, modification time, size, content hash,
text. Backlinks are derived from outgoing links.

(Default) As in Obsidian's metadata cache, IndexedDB holds two stores: path
to modification time, size and hash; and hash to parsed entry. A file is
re-read only when its modification time or size changed, and re-parsed only
when its hash is new. A Drive re-download that touches the time but not the
content costs one read and no parse.

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
  - (Default) Every tool declares MCP annotations, as Gloss's server does:
    `readOnlyHint` on the read tools, `destructiveHint` on `rename_note`,
    `move_note`, `delete_note`, `write_note` and `promote_staging`, and
    `idempotentHint` on `daily_note` and the staging tools.
- **Guards:**
  - Writes under `sources/notion/` and `.brain/` are refused, except
    staging and the server's own log, journal, `history/`, `trash/` (for `delete_note`), `import/`, and
    the `starred.json` update a rename needs.
  - `edit_note` fails with "changed since read, re-read first" when the file
    changed after Claude's last read.
  - A per-path lock serialises parallel calls.
  - Writes go to a temporary file that is then renamed into place. Every
    write is logged.
  - Before any write, rename or delete changes an existing file, the old
    file is copied to `.brain/history/<date>/`. The server sweeps copies
    older than 7 days on start.
  - Rename rewrites links in properties, embeds and `.brain/starred.json`,
    the same plan the Brain page runs.

## Error handling

Data-loss paths are handled in full. Each row has a test.

| Failure | Response |
|---|---|
| Crash or power loss mid-write | Chrome: `createWritable()` swaps in the file on `close()` (assumption, checked by crash injection). Node: temporary file, then rename. |
| Folder permission lost | Read-only from the cache, reconnect banner, edits buffered and flushed after reconnecting. |
| Drive offline, or a streamed file not yet downloaded | 5 s read timeout, then the cached copy with an "offline copy" badge; writes buffered and retried. |
| Write fails (disk full, file locked) | Persistent "Not saved, retrying" state; never shows saved falsely; offers an export of the buffer to Downloads. |
| IndexedDB quota exceeded | Buffer kept in memory, banner shown, export offered. |
| Drive conflict copy (`Note (1).md`) or partial sync | Found during reconcile; snapshot, then merged by the same auto-merge with a notice; the copy goes to trash, never deleted outright. |
| Auto-merge produces odd text (overlapping edits) | A snapshot always exists from just before; the notice links to History; Restore is one click. |
| Conflict copy of `.brain/starred.json` or `.brain/types.json` | Merged key by key (Obsidian merges JSON this way in its sync); for a key set on both sides, this device's value wins. |
| Snapshot storage over quota | Oldest snapshots evicted first; a snapshot taken before a merge or Claude write is never evicted before 7 days. |
| `.base` with unsupported expressions, or invalid YAML | Rows listed unfiltered with a note, or the raw file with a warning; never a crash. |
| Embed loop or deep nesting | Stops at 3 levels; a loop renders as a plain link. |
| Heading rename collides with an existing heading in the note | Links resolve to the first match, as Obsidian does; the rename prompt warns. |
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
| Unit | Frontmatter round-trip is byte-identical; typed properties and types.json; links (body, embeds, properties); rename and move plans, including heading renames; names (NFC, sanitising, length, case); mentions; the query parser (every operator, every error); search ranking; blocks and tasks; block moves; merge; journal replay; URL matching for papers; `base.ts` against every view shape the import writes; table grid edits; template variables; the Notion block, property and view mappings. | `check` |
| Property | `fast-check` with a fixed seed in CI and the seed printed on failure. **Invariants:** after any sequence of create, rename (note or heading), move, delete and edit, no link or embed is broken and every backlink is symmetric; `parse(serialize(x))` equals `x`; merge returns theirs when mine equals base, mine when theirs equals base, and keeps both edits when they touch paragraphs that are apart; replaying a journal after a crash at any step leaves either the start state or the end state; query parse then print gives back an equivalent query; a table grid edit changes only the rows it touched; a block move followed by its reverse gives back the original bytes. | `check` |
| Concurrency | Brain page and MCP editing one note. Two Brain tabs. Parallel MCP calls. A fake Drive agent in tests that delays copies, makes conflict copies and delivers partial files. Crash injection at every journal step. | `check` (Node on temp folders) and `e2e` |
| Load | Generated vaults of 500, 5,000 and 20,000 notes in nested area folders: index build, tree render, switcher, search (plain and with operators), opening the last note, the longest animation frame while typing (Long Animation Frames API). CI fails at about 3x the real budgets, following `e2e/load.e2e.ts`; `npm run bench:brain` checks the real budgets locally. | New `e2e/brainLoad.e2e.ts` |
| Regression | Every fixed bug gets a failing test first (CLAUDE.md section V). A **synthetic** fixture vault (areas, LaTeX, images, PDFs, lecture MOCs, merged concepts with a disagreement callout, tasks, clashing titles, accents, emoji, a paper with `url:`, a database folder with a `.base`, collapsible callouts, note embeds, a template) with checked-in expected index and search output. None of the user's notes are in the repo. | `check` |
| Edge cases | Every row of the error-handling table. | Both |
| Oracles | The checks in Oracles that need none of the user's data: the Obsidian-dump diff of the fixture vault, the parser differentials, the model-based concurrency tests. The audit, the crash harness and the diff of the real vault run locally only. | `check`, and local |
| E2E | The Brain page in real Chromium. The native folder picker cannot be automated, so tests give the page a folder from the browser's private file storage (OPFS), which has the same handle interface. The real `vault.ts` runs against it. Also covered: the bookmarks handoff, the papers chip, the omnibox, the merge notice and History restore, the slash menu, block moves by key and by drag, the table grid, the properties panel, hover preview, embeds, starring, templates, `>` commands, and an axe check against `e2e/a11yBaseline.ts`. | `e2e` |
| Manual, before milestone 1 is done | On Mac and Windows: Drive stream-mode reads, a forced conflict copy (auto-merged, then restored from History), a Claude edit restored from `.brain/history/` on Windows, the network dropped mid-save, permission revoked mid-session, both shortcuts, a `.base` opened in both the extension and Obsidian, a VoiceOver pass of the Brain page. | Checklist |

## Build order

Stop points from Milestone 1 scope are marked.

0. **Baseline, before any code.** All of these go to
   `.brain/reports/baseline.md`:
   - Usage counts from Chrome's History.
   - The recall benchmark: declined by the user on 2026-10-15.
   - The card sort.
   - Notion's export of the in-scope areas.
   - The Notion link measure from `notion.db`.
1. **Platform ground truth, about a day.**
   - Read Chromium's blocked-path list and swap-file write path for the
     installed Chrome version.
   - Then the harness: does `showDirectoryPicker()` on an extension page
     open, read and write `~/Library/CloudStorage/GoogleDrive-…/My
     Drive/brain`?
   - Measure on Mac and Windows the Drive behaviours listed in Ground
     truth.
   - The results go into a "Measured platform" table added at the end of
     this spec. Every assumption and error-table row that rests on them is
     rechecked.
   - Fallback if Chrome blocks the folder: switch Drive to Mirror mode, with
     the folder outside `~/Library`.
2. `src/shared/brain/*`, test first: unit, property and fixture tests.
3. MCP server, plus its concurrency and guard tests; register it.
4. Area map and naming list, approved by the user.
5. Pilot import (Deep Learning Class), review in Obsidian, promote.
6. Remaining areas, then `Home.md` and the topic MOCs, then
   `bookmarks.json`. **Stop A.**
7. Brain page, read-only: vault I/O, index, tree, note view, switcher,
   search, panels, PDFs into the reader, papers chip, entry points,
   onboarding, Options section, bookmarks handoff, `.base` row lists.
   **Stop B.**
8. Brain page, core editing: editor, autosave, auto-merge, history,
   recovery, locks, tasks, rename (notes and headings), move, delete, daily
   notes. Then e2e, load and the manual checklist for this stage. **Stop C.**
9. **Editor extras, after a two-week diary at stop C.**
   - The user does real writing in the Brain page, with Notion still open,
     and logs each friction as one dated line in a `Brain diary` note.
   - The extras (outline, starred, `>` commands, hover preview, note embeds,
     slash menu, templates, block moves, properties panel, table grid) are
     built in the order the diary calls for.
   - An extra the diary does not mention is flagged for the user to keep or
     drop before it is built.
   - Then their e2e and the full manual checklist. **Stop D.**

## Out of scope for milestone 1

- Live co-editing, comments, version history and cross-machine auto-merge
  (milestone 2).
- All AI (milestone 3).
- New-tab card, reader strip, highlights and flashcards (milestone 4).
- The job tracker, the table UI, and board and calendar layouts
  (milestone 5). Editing `.base` files in the extension.
- Graph view, mobile, block references, note tabs and split panes,
  drag-and-drop in the tree (Starred reorders by drag; the tree does not),
  editable embeds (Notion's synced blocks), page icons and covers, and the
  MCP server on Windows.
- Reading or writing Obsidian's own `.obsidian/` config.

## Open risks

- The Chrome folder picker under `~/Library/CloudStorage`: settled by
  Chromium's source and the step 1 harness, before step 2.
- The outcome targets can fail even when every engineering check passes.
  That is the point of measuring them; a miss at stop B is reported with
  the benchmark's misses before stop C starts.
- Drive stream mode: first reads can be slow or fail offline. The user marks
  `brain/` "Available offline" in Drive.
- The full atomic rewrite with merged concepts edits the user's words across
  hundreds of pages. Mitigated by verbatim sources, coverage reports, merge
  logs, the disagreement rule and the pilot; not eliminated.
- Two writers, the Brain page and the MCP server, with only a fuzzy
  auto-merge between them until milestone 2. Overlapping edits can merge
  oddly and without a prompt; every merge is preceded by a snapshot and
  announced, so it is recoverable, not prevented.
- Notion stays partly live (unfrozen areas, the job tracker) until milestone
  5, so for a while the source of truth depends on the area.
- Milestone 1 roughly doubled in the third interview. Stop D holds the
  additions, so stops A to C ship first and stay usable on their own.
- `.base` is Obsidian's format, not a published standard; it may change.
  The import writes a small subset, and fixture tests pin what the
  extension reads.

## What we took from Obsidian and Notion

The installed apps were read with REA static analysis and plain text
search. Nothing was run, and no page content was read from the Notion
cache, only its schema and type counts.

| Source | Observed | Used for |
|---|---|---|
| Obsidian 1.13.7 (`obsidian-1.13.7.asar`, sha256 `a52a7daf…059d`) | Autosave debounced 2 s; on a failed save, a snapshot and an error notice. | Autosave and the failed-save row. |
| | External change with unsaved edits: `patch_apply(patch_make(base, diff(base, mine)), disk)` with diff-match-patch, then a "file changed" notice; no conflict UI. | External change. |
| | File recovery: snapshots every 5 min, kept 7 days, in IndexedDB indexed by path and time; also taken before its sync overwrites a file; a line diff view with word highlights and folded runs. | Version history. |
| | Metadata cache in IndexedDB: path to (mtime, size, hash), and hash to parsed metadata; a re-parse only on change. | The index stores. |
| | Search operators: `file path content match-case ignore-case line block section task task-todo task-done tag`. | Confirms the search section. |
| | Bases: `.base` keys `views filters display properties formulas newItemFolder newItemTemplate`; views `table cards list map` with `filters groupBy order sort limit summaries`; functions `file.inFolder hasTag hasLink hasProperty`; property types `text multitext number checkbox date datetime aliases tags`. | Databases, typed properties, `base.ts`. |
| | Its sync merges JSON files key by key and keeps a conflicted copy. | The `.brain/*.json` conflict row. |
| Notion 7.35.1 (`app.asar`, sha256 `b0c0a08e…b3d8`), local `notion.db` schema | Every block is a record with id, parent, ordered children, version and trash fields; about half carry CRDT text. | Supports Yjs in milestone 2; why block refs stay out of a markdown vault. |
| | Unsent edits queue in a `transactions` table; permanent failures go to `unretryable_failed_transactions`, kept, not dropped. | Matches buffered writes plus export on failure. |
| | The user's content by type: 1,931 images, 1,053 table rows in 98 tables, 648 to-dos, 196 equations, 192 code blocks, 81 page links, 33 columns in 13 layouts, 28 callouts, 28 transcriptions, 11 toggles; views 42 table, 9 list, 8 board, 7 gallery, 2 calendar; properties mostly text, select, status, number, date, relation. | Block, property and view mappings. |
| Gloss (github.com/Nutlope/gloss at `54b13b8`, source read; no license, so ideas only, no code) | Highlights exported as one Markdown note per text in reading order; a daily review of 5 highlights on 3/7/16/35/75/160-day steps with state on the highlight; the whole text in a cached system prompt with `[¶n]` citations limited to paragraphs sent; MCP tools with read-only and destructive hints. | Milestones 3 and 4; MCP annotations. |
| Product behaviour, not code | Notion's slash menu, block drag, properties at the top of a page, favorites; Obsidian's hover preview, embeds, outline, bookmarks, Templates plugin. | Editor extras. |
