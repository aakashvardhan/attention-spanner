# World model: the extension as a place you stand in

*2026-10-08. Approved section by section in brainstorming. The throwaway
prototype is `2026-10-08-world-model-prototype.html` beside this file (an HTML
fragment from the brainstorm companion; open it in a browser, click inside the
world, then J/K, Enter, F, V).*

## Idea

A world model is how a robot understands its surroundings: what it sees from
its own camera, what the objects are, and what happens next. Here **you are the
agent, the extension is your world model, and the new tab is your egocentric
view.** Unfinished reading stands on a path ahead of you, feeds arrive along a
lane beside it, your reading year is the ground, and the sky is the real time
and weather. Papers is a second world: your library as a constellation.

Visual language is **Sim Lab** (chosen over Lidar and Ego Cam): the Edition's
paper tone, serif headlines and Clay accent stay; the simulation arrives as a
viewfinder frame, monospace telemetry, a target lock, forecast bands, and
depth.

## Principles

**Every overlay is a real measurement.** No decorative numbers, no invented
telemetry. If the frame shows `rollout 38m ±9`, the extension computed it.

**Things you read live in the world; tools you use live in the frame.** Panels
for articles, papers and feed items are placed in 3D. Inputs (brain dump,
paper editor, favorites, buttons) dock to the screen-fixed frame and never move
with the camera.

Company guidance, turned into rules:

| Source | Rule | Enforced by |
|---|---|---|
| Meta, VR comfort and locomotion | Camera moves only on user input. Edge vignette only while it moves, fading on stop. Comfort setting: Recommended (glide + vignette) and Comfortable (snap cut). No pitch or roll; yaw within ±15°. | `camera.test.ts`; vignette is applied inside the camera move, never separately |
| Apple, visionOS design | Depth carries hierarchy: nearer is more important. A locked object's text renders at ≥16px effective. Only the frame is screen-fixed. | `camera.test.ts` |
| Google, Material 3 Expressive | Springs for spatial motion; separate effects timing for opacity and colour. | `motion.test.ts` (extended) |
| Microsoft, Fluent 2 and Inclusive Design | Flat view is a full equal, forced under Reduce Motion. Focus mode subtracts. Frame text over the sky meets WCAG AA 4.5:1. | `theme.test.ts` (extended), `viewMode` test |
| Netflix | Continue is the nearest object; Enter opens it. Ambient motion is user-switchable and persists. | existing Enter handling; settings |
| Amazon, working backwards | Open a tab, be back in your paper in one keystroke, never waiting on the world. Text paints first; the world fills in behind. | `/verify` timing |

Nvidia and OpenAI publish no general UI guidelines that could be verified; no
rule is attributed to them.

## Rendering

CSS 3D on real DOM: `perspective` on the world container, `preserve-3d` scene,
panels placed with `translate3d`. Text stays selectable, focusable and
screen-reader visible. A small canvas (no library) draws the sky. No WebGL, no
new rendering dependency.

Gotcha found in the prototype: Chrome clips ink overflow (outline, pseudo
elements outside the border box) on 3D-transformed elements. Lock styling is
drawn inside the panel's border box; labels are separate elements.

## 1. New tab

| Today | In the world |
|---|---|
| Lead + "Also unfinished" | Panels on the path; distance = days since last touched; progress bar with forecast band; lead nearest |
| From your feeds | A lane to the right, angled toward the path; relevance and "because you read" on the panel |
| The Record heatmap | Terrain left of the path; reading days are raised tiles; Both / Papers / Focus switch in the frame |
| NowWatching | A panel beside the lead, only while a video plays |
| Masthead, clock, weather, greeting | Frame top edge; the sky draws real time of day and weather |
| Brain dump | Docked bottom-left of the frame |
| Favorites, Papers, Settings, Start focus | Docked bottom-right of the frame |
| Obstacle course | A robot running the path's edge that draws a ghost of each jump before it jumps |
| Quote of the day | Small text on the horizon |

**Modules** (`src/pages/newtab/world/`):

- `layout.ts` (pure): items → 3D positions. No overlaps. At most 9 objects;
  more becomes a "+N more" sign at the end of the path. Deterministic.
- `camera.ts` (pure): selected object → camera transform, holding the comfort
  rules.
- `World.tsx`: renders the scene and frame; replaces the body of
  `Dashboard.tsx`. Data loading stays in `Dashboard.tsx`.
- `Sky.tsx`: canvas sky from time and `Weather` data.
- J/K/Enter keep the `[data-story]` order in `Dashboard.tsx`; focus styling
  becomes the lock ring.

**States.** Empty: one signpost on the path with today's hint text. Focus
active: fog closes on the lead, countdown in the frame, ambient paused.

**Settings** (Options › New Tab): View (World / Flat; Flat forced under Reduce
Motion), Comfort (Recommended / Comfortable), Ambient motion (on / off; paused
during focus regardless).

## 2. Other pages

**Stepping in.** Opening from the world replaces the new tab, as Chrome's own
new tab does. The camera dollies into the panel and a cross-document View
Transition carries it into the reader's title; Back reverses it. ⌘/Ctrl+Enter
or ⌘-click opens a new tab instead. External destinations (original article,
alphaXiv) get the dolly, then a plain navigation. `OPEN_ARTICLE` gains the
current tab id so tracking registers the navigated tab instead of creating one.

**Reader.** Calm. The focus line is restyled as the fovea; the toolbar shows
`p4/19 · 26% · rollout 38m ±9` from `readingAids.minutesLeft()`. Viewfinder
brackets appear only during step in and out. Nothing moves while reading.

**Blocked page.** The robot meets the blocked site, sketches a detour, the
detour is rejected, it stops. Countdown and hold-to-quit unchanged. One still
frame under Reduce Motion.

**Options.** Flat, Sim Lab styling (frame brackets, monospace section labels).
Adds the View / Comfort / Ambient settings and a restored alphaXiv section
(connect, disconnect, signed-in account).

**Papers: constellation with a docked editor.**

- Layout: abstract embeddings from Ollama, reusing recall's vector cache,
  projected to 2D by a small on-device PCA (power iteration, no library).
  Decks are labelled regions; deck filter in the frame. No Ollama or missing
  vectors: deterministic grid by deck, and the frame says why.
- Nodes: size = progress; hollow = to read, Clay = reading, ink = read.
- Edges: cosine at or above a threshold (`ponytail:` calibration knob), at most
  3 per paper.
- J/K flies between papers; the selected one locks; its `PaperRow` controls
  dock in the frame's right side; Enter opens it.
- **Unexplored stars:** alphaXiv `discover_papers`, seeded with papers you are
  reading, places up to 8 related papers not in your library at the rim
  (faint, dashed). One call per day, cached. Selecting one shows its abstract
  in the docked panel; "Add to deck" adds it. Signed out: no stars and one
  dismissible frame line offering to connect.
- **Library sync:** restored from `1378832^`, trimmed: decks ↔ alphaXiv
  folders, to read / reading / read ↔ alphaXiv status folders, both ways; on
  Papers open and on status change. arXiv papers only.
- Flat view: today's list.

**alphaXiv plumbing.** Restore and trim from `1378832^`:
`background/alphaxivAuth.ts` (OAuth 2.1, PKCE, dynamic client registration,
`chrome.identity.launchWebAuthFlow`), `background/alphaxivMcp.ts` (Streamable
HTTP MCP client in the service worker, which host permissions exempt from
CORS), `shared/alphaxiv.ts` and its tests. Re-add the `identity` permission.
Only arXiv papers are ever sent, matching `llm/route.ts`.

**Open item, blocks the plan:** confirm the server's current tool names and
arguments. The endpoint (`https://api.alphaxiv.org/mcp/v1`) answered 401 with
`authorization_uri=https://api.alphaxiv.org/auth` and advertises dynamic
registration and S256 PKCE on 2026-10-08, but tools cannot be listed without
signing in, and the August names (`discover_papers`, `list_library`,
`save_papers_to_folder`) may have changed.

## 3. Motion, comfort and CI

**Tokens.**

| Role | Token | For | Rule |
|---|---|---|---|
| Camera | `--spring-smooth` / `--dur-smooth` | glide, step in and out | never overshoots |
| Lock | `--spring-snappy` / `--dur-snappy` | lock ring, docked panel | small overshoot allowed |
| Appear | `--spring-bouncy` / `--dur-bouncy` | stars and panels appearing | appearing only |
| Effects (new) | `--ease-effect`, `--dur-effect-fast` 120ms, `--dur-effect-slow` 480ms | fog, vignette, fades, colour | no springs |

**Ambient motion.** One `useAmbient()` hook owns every `requestAnimationFrame`
loop (sky, clouds, robot, masthead strip). It stops them when ambient is off,
during focus, under Reduce Motion, and when the tab is hidden. The setting plus
a pause button in the frame satisfy WCAG 2.2.2.

**CI** (inside the existing `npm test`; no browser in CI):

1. `motion.test.ts`: `transform` motion uses spatial tokens; `opacity`,
   `filter`, colour use effects tokens; `infinite` animations are stilled
   under Reduce Motion.
2. `ambient.test.ts`: `requestAnimationFrame` or `infinite` animations only in
   files that go through `useAmbient` (allowlist; PDF.js exempt).
3. `camera.test.ts`: pitch = roll = 0; |yaw| ≤ 15°; locked text ≥ 16px
   effective; camera token monotonic (parsed from `theme.css`).
4. `layout.test.ts`: no overlaps; ≤ 9 objects plus "+N"; distance increases
   with staleness; deterministic.
5. Constellation: projection stable; fixture-similar abstracts land closer than
   unrelated; ≤ 3 edges per paper; grid fallback without vectors.
6. `theme.test.ts`: fog, vignette and frame-text tokens in light and dark;
   frame text over sky colours ≥ 4.5:1.
7. `viewMode(setting, reducedMotion)` returns flat under Reduce Motion.
8. alphaXiv: restored helper tests, plus "only arXiv papers are ever sent".

Flat and world render the same DOM, so they cannot diverge.

**`/verify`, not CI:** frame rate during camera moves, time until input
responds, and screenshots of every page in light and dark, Reduce Motion on
and off.

## Sequencing

1. Commit and merge the uncommitted `pixel-walk` work. `World.tsx` absorbs
   `Hero.tsx`, `BrainDump.tsx` and `ObstacleCourse.tsx`, which that branch
   changes.
2. history-feeds (`docs/superpowers/specs/2026-10-08-history-feeds-design.md`
   on branch `history-feeds`). Its TriageCard changes land before the feed
   lane reuses that component.
3. This spec, in plan order: motion tokens and lints → layout and camera →
   new-tab world → stepping in and reader → blocked and Options → alphaXiv
   restore → Papers constellation.

## Out of scope

WebGL or any 3D library; free-roam movement (WASD, mouse-look); sound; an
avatar; citation edges; alphaXiv ask-the-paper; browser tests in CI.
