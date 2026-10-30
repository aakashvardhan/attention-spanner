# Topic Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continue keeps only what is on the user's topics (AI, robotics and reinforcement learning by default), and never records the extension's own pages.

**Architecture:** A pure keyword matcher in `src/shared/topics.ts`, plus a background gate in `src/background/topicGate.ts`. The gate falls back to local Ollama embeddings, with a 1.5 s budget and a per-item verdict cache. The gate runs where entries are first created: `handleVideoReady` for videos and `handleProgressUpdate` for pages. Explicit "read this" opens skip it. Existing data is handled in two places: a v26 migration removes non-http entries, and a one-time background sweep deletes only what the local model calls off topic.

**Tech Stack:** TypeScript, React 18, MV3 service worker, vitest, Playwright e2e (`npm run build:e2e`, `vitest.e2e.config.ts`), Ollama `/api/embed` through `src/shared/llm/ollama.ts`.

**Spec:** `docs/superpowers/specs/2026-10-30-topic-filter-design.md`

## Global Constraints

- Branch `minimal-revamp`. Never stage `CLAUDE.md`, which shows as deleted in the working tree.
- Read settings with `useSettings()` in pages and `getSettings()` in the worker. Never use `useStorageValue('settings')`.
- Default topics, verbatim: `['AI', 'robotics', 'reinforcement learning']`. An empty list turns the filter off.
- Classification stays on device: keywords first, then local Ollama. No cloud calls.
- The model only widens what is kept. It never overrides a keyword match.
- Misfile toward keeping. A timeout, an Ollama error, no model, or no title all mean keep.
- A verdict is computed at most once per normalized URL or videoId.
- The gate applies only when an entry is first created. Existing entries are never removed by the gate.
- Papers are never gated or swept.
- "Read this" (the shortcut and the context menu) is always tracked.
- New CSS uses tokens only, and `src/shared/designSystem.test.ts` must pass.
- Per-task gate:
  - focused unit and edge tests
  - `npm run -s typecheck && npm test` (report the count)
  - e2e for UI-facing or tracking tasks
- Known e2e exceptions: the arXiv network test in `reader.e2e.ts`, and `zz-scrollperf` (needs env `PDF`).

## Review Focus

1. **An off-topic entry that already exists keeps updating.** Reopening it from Continue must not delete it, because the gate only fires on creation. Test: Task 4, `existing entry is never gated`.
2. **Ollama down or slow.** A keyword miss with an unreachable or slow model keeps the item, and nothing throws. Test: Task 3, `timeout keeps` and `error keeps`.
3. **Topics edited to empty.** Everything is tracked, as today. Test: Task 2, `empty topics match everything`, and Task 4, `empty topics track off-topic video`.
4. **A user-added multi-word topic** ("quantum computing") matches whole words, ignoring case, and does not match inside other words. Test: Task 2, `custom topic whole words`.
5. **The same off-topic video reopened.** It is not re-asked: the verdict cache answers, and the embed stub sees zero calls. Test: Task 3, `cache answers repeat`.

---

### Task 1: Never record the extension's own pages, and schema v26

**Files:**
- Modify: `src/background/tracking.ts`, at `handleProgressUpdate`. Return before any write when the resolved key's URL isn't `http(s):`.
- Modify: `src/shared/storage.ts`. In `migrate()`, under `version < 26`, remove `readingProgress` entries whose `url` isn't `http(s):`, then set `schemaVersion: 26`. Move the early return to `>= 26`, and update the doc comment with a `v25 → v26` line.
- Test: `src/background/tracking.test.ts`, `src/shared/storage.test.ts`

**Interfaces:**
- Produces: `v26Progress(map: Record<string, unknown> | undefined): Record<string, unknown> | null` in `storage.ts`. It drops entries whose `url` is not `http(s):` and returns null when nothing changed.

- [ ] **Step 1: Failing tests**
  - `tracking.test.ts`, `ignores an extension page`: `handleProgressUpdate` with `doc: { url: 'chrome-extension://abc/src/pages/newtab/index.html', title: 'Focus workspace' }` and a tab with no tracked key writes nothing (`readingProgress` unchanged). Do the same for `chrome://newtab/`.
  - `storage.test.ts`:
    - `v26Progress({ a: { url: 'chrome-extension://x/n.html' }, b: { url: 'https://ex.com' } })` equals `{ b: { url: 'https://ex.com' } }`
    - `v26Progress({ b: { url: 'https://ex.com' } })` is `null`
    - `v26Progress(undefined)` is `null`
- [ ] **Step 2:** Run `npx vitest run src/background/tracking.test.ts src/shared/storage.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Gate `handleProgressUpdate` at the shared writer, not at a single caller. Also check `git grep "readingProgress\\[" -- src/background` for any other creator of entries, and guard it the same way.
- [ ] **Step 4: Regression.** Update the existing full-legacy-profile sentinel test and the idempotency test to schema 26. Seed one `chrome-extension://` entry and assert it is gone. Assert every kept sentinel is deep-equal.
- [ ] **Step 5:** Gate: run `npm run -s typecheck && npm test`, then e2e `continue` and `smoke`.
- [ ] **Step 6:** Commit `Never track extension pages; v26 removes them`.

---

### Task 2: Topics, the keyword matcher and the setting

**Files:**
- Create: `src/shared/topics.ts`, `src/shared/topics.test.ts`
- Create: `src/pages/options/TrackTopicsRow.tsx`. It follows `MutedTopicsRow.tsx` and is rendered in Options under a small "Continue" section placed above "Your Feeds".
- Modify: `src/shared/types.ts` (`Settings.trackTopics: string[]`), `src/shared/storage.ts` (`DEFAULT_SETTINGS.trackTopics`)

**Interfaces:**
- Produces:

```ts
export const DEFAULT_TOPICS: readonly string[]; // ['AI', 'robotics', 'reinforcement learning']
export function normalizeTrackTopics(value: unknown): string[]; // trimmed, de-duplicated (case-insensitive), max 20, each ≤ 40 chars; non-array → DEFAULT_TOPICS
export function keywordOnTopic(text: string, topics: readonly string[]): boolean; // empty topics → true
```

- Synonym sets are keyed by lower-cased topic name.
  - **`ai`:** seed from the 'AI' pattern in `git show 0c70025:src/shared/videoCategory.ts`, minus `\bagents?\b`, which is too broad.
  - **`robotics`:** the 'Robotics' pattern from the same file.
  - **`reinforcement learning`:** `reinforcement learning`, `\bRL\b`, `\bPPO\b`, `\bDQN\b`, `policy gradient`, `Q-learning`, `actor-critic`, `\bMDPs?\b`, `\bbandits?\b`, `reward model`.
- A topic with no synonym set matches as a whole phrase, ignoring case.

- [ ] **Step 1: Failing tests** in `topics.test.ts`:
  - `default topics keep the screenshot's titles`. Each of these is `true` against `DEFAULT_TOPICS`:
    - `Learning Fine-Grained Bimanual Manipulation with Low-Cost Hardware`
    - `Proximal Policy Optimization Algorithms`
    - `Playing Atari with Deep Reinforcement Learning`
    - `RL Course by David Silver - Lecture 1: Introduction to Reinforcement Learning`
    - `V-JEPA 2: Self-Supervised Video Models Enable Understanding, Prediction and Planning`
  - `default topics drop the obvious misses`. Each of these is `false`:
    - `Focus workspace`
    - `Lofi hip hop radio - beats to relax/study to`
    - `Best pasta recipe in 10 minutes`
    - `Wasmer (YC S19) Is Hiring OS/Hypervisor Experts in Europe`
  - `empty topics match everything`: `keywordOnTopic('Best pasta recipe', [])` is `true`.
  - `custom topic whole words`:
    - `keywordOnTopic('Intro to Quantum Computing', ['quantum computing'])` is `true`
    - `keywordOnTopic('quantumcomputingly', ['quantum computing'])` is `false`
  - `RL needs a word boundary`: `keywordOnTopic('Girl talk', DEFAULT_TOPICS)` is `false`
  - `normalizeTrackTopics`:
    - `[' AI ', 'ai', '']` gives `['AI']`
    - `'nope'` gives `DEFAULT_TOPICS`
    - 25 items are capped at 20
- [ ] **Step 2:** Run `npx vitest run src/shared/topics.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. V-JEPA must match, through "Self-Supervised" or "Video Models", by adding `self-supervised` and `world models?` to the `ai` set. If a different word is needed, say so in the commit.
- [ ] **Step 4:** Add the setting and the Options row. The row saves through the same pattern `MutedTopicsRow` uses.
- [ ] **Step 5: E2E.** In `e2e/smoke.e2e.ts`, the Options page shows the topics field holding the three defaults. Editing it to `AI` persists `settings.trackTopics === ['AI']` (use `waitForFunction` on storage).
- [ ] **Step 6:** Gate. Then commit `Topics setting and keyword matcher`.

---

### Task 3: The model stage, verdict cache and time budget

**Files:**
- Create: `src/background/topicGate.ts`, `src/background/topicGate.test.ts`
- Create: `scripts/measure-topic-threshold.mjs`. This is a manual tool. It embeds the labelled fixture against a running Ollama and prints the lowest on-topic and highest off-topic similarity.
- Create: `src/background/topicFixture.ts`. It holds 36 labelled titles, 18 on topic and 18 off, and the measurement script and the tests share it.
- Modify: `src/shared/storage.ts`. Add `SessionSchema.topicVerdicts: Record<string, boolean>`, default `{}`.

**Interfaces:**
- Consumes: `keywordOnTopic`, `normalizeTrackTopics` (Task 2); `embed` (`src/shared/llm/ollama.ts`); `cosine` (`src/shared/llm/vectors.ts`).
- Produces:

```ts
export const TOPIC_SIM_MIN: number;      // measured; see Step 4
export const TOPIC_BUDGET_MS = 1500;
/** Keyword verdict, then model; null = model unavailable or failed. Cached per key. */
export function topicVerdict(key: string, text: string, deps?: { embed?: typeof embed; now?: () => number }): Promise<boolean | null>;
/** Gate for creation points: resolves within TOPIC_BUDGET_MS. 'keep' | 'drop'; on timeout 'keep' and calls onLateDrop if the late verdict is false. */
export function gateNewItem(key: string, text: string, onLateDrop: () => Promise<void>, deps?: {...}): Promise<'keep' | 'drop'>;
```

- `topicVerdict` behaves as follows:
  - It returns `true` immediately on a keyword match or when topics are empty.
  - With no `ollamaUrl` or `ollamaEmbedModel`, it returns `null`.
  - Otherwise it returns `max(cosine(textVec, topicVec_i)) >= TOPIC_SIM_MIN`.
  - Embed errors return `null`.
  - The result is written to `topicVerdicts[key]` unless it is `null`.
- `gateNewItem` maps the verdict as follows:
  - `null` or `true` gives `'keep'`.
  - `false` gives `'drop'`.
  - On timeout it gives `'keep'`, and calls `onLateDrop` only if the late verdict is `false`.

- [ ] **Step 1: Failing tests** in `topicGate.test.ts`. They use a stub `embed`, with no real Ollama and a fake `chrome.storage.session`.
  - `keyword match skips the model`: the stub sees 0 calls.
  - `model keeps a similar title`: the stub returns vectors with cosine ≥ `TOPIC_SIM_MIN`, so the verdict is `true`.
  - `model drops a distant title`: verdict `false`, and `gateNewItem` gives `'drop'`.
  - `no model configured keeps`: verdict `null`, gate gives `'keep'`.
  - `error keeps`: the stub throws, giving `null` and `'keep'`.
  - `timeout keeps, late drop removes`: the stub resolves `false`-ish vectors after 2000 ms (fake timers). The gate gives `'keep'` at 1500 ms, then `onLateDrop` is called once.
  - `cache answers repeat`: a second `topicVerdict` for the same key makes 0 stub calls.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Embed the topic list once per worker lifetime, keyed by `ollamaEmbedModel + topics`.
- [ ] **Step 4: Threshold.**
  - If `curl -s localhost:11434/api/tags` answers and an embed model is installed, run `node scripts/measure-topic-threshold.mjs`. Set `TOPIC_SIM_MIN` just below the lowest on-topic similarity, and record the printed numbers in a comment.
  - Otherwise set `TOPIC_SIM_MIN = 0.35`, with the comment `// ponytail: unmeasured default, leans to keeping; run scripts/measure-topic-threshold.mjs against your Ollama`. Report which path was taken.
- [ ] **Step 5:** Gate. Commit `Topic gate: local model fallback, 1.5s budget, verdict cache`.

---

### Task 4: Wire the gate into videos and pages

**Files:**
- Modify: `src/background/videoTracking.ts`, in `handleVideoReady`. Gate only when no `readingProgress` entry exists for this video. On `'drop'` return `track: false`. `onLateDrop` deletes the entry.
- Modify: `src/background/tracking.ts`:
  - `registerOpenedTab(tabId, url, resume, explicit = false)` stores `explicit` in `trackedTabs[tabId]`.
  - In `handleProgressUpdate`, the creation branch (`!existing`) runs `gateNewItem` with `title + ' ' + hostname` unless the tab is explicit or the title is empty.
  - On `'drop'`, return without writing.
- Modify: `src/background/feeds.ts`. `openArticle` passes `explicit = feedItemId === null && !resume` to `registerOpenedTab`. Both "read this" callers already pass `feedItemId: null` and `resume: false`.
- Modify: `src/shared/storage.ts` (`SessionSchema.trackedTabs` value gains `explicit?: boolean`)
- Test: `src/background/tracking.test.ts`, `src/background/videoTracking.test.ts` (create it if missing), `e2e/continue.e2e.ts`

**Interfaces:**
- Consumes: `gateNewItem` (Task 3).

- [ ] **Step 1: Failing unit tests.** Stub the gate module.
  - `off-topic video is not tracked`: `handleVideoReady` for `Best pasta recipe` gives `track: false`, and no entry is written.
  - `on-topic video is tracked`: `RL Course by David Silver…` gives `track: true`.
  - `existing entry is never gated`: a stored video entry plus an off-topic title gives `track: true`, and the gate stub sees 0 calls.
  - `empty topics track off-topic video`: `trackTopics: []`, `Best pasta recipe`, gives `track: true`.
  - `news page off-topic is not stored`: no entry after `handleProgressUpdate` for a non-explicit tracked tab titled `Wasmer (YC S19) Is Hiring…`.
  - `read this keeps an off-topic page`: an explicit tracked tab with the same title stores an entry.
  - `no title keeps`: an empty title stores the entry, and the gate stub sees 0 calls.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4: E2E** in `continue.e2e.ts`, with Ollama off (port 9) so keywords decide.
  - Open an off-topic News item: no Continue row.
  - Open an on-topic News item: a row appears.
  - Use "read this" (`OPEN_ARTICLE` with `feedItemId: null`) on the off-topic page: a row appears.
- [ ] **Step 5:** Gate. Run e2e `continue`, `smoke`, `load` and `triage`. Commit `Gate new Continue entries by topic; read-this always tracks`.

---

### Task 5: One-time sweep of existing entries

**Files:**
- Create: `src/background/topicSweep.ts`, `src/background/topicSweep.test.ts`
- Modify: `src/shared/storage.ts`. Add `LocalSchema.topicSweepDone: boolean`, default `false`, and add `'topicSweepDone'` to the test's `KEPT_LOCAL_KEYS`.
- Modify: `src/background/index.ts`. Call `void runTopicSweepOnce()` from `onInstalled`, after `migrate()`.

**Interfaces:**
- Consumes: `topicVerdict` (Task 3), `keywordOnTopic` (Task 2).
- Produces: `runTopicSweepOnce(deps?: { now?: () => number; verdict?: typeof topicVerdict }): Promise<{ removed: string[] }>`
- The sweep loads `readingProgress` and skips any entry `updatedAt` within 24 h. It deletes an entry only when `keywordOnTopic` is false **and** `topicVerdict` returns `false`. It sets `topicSweepDone: true` only after a pass in which the model was reachable for every keyword-missed entry. Otherwise it leaves the flag false, so the next install retries.

- [ ] **Step 1: Failing tests:**
  - `keyword miss with no model keeps`
  - `keyword miss with model off-topic removes`
  - `recent entry kept`, with an off-topic entry updated 1 h ago
  - `keyword hit kept without asking`: 0 verdict calls
  - `runs once`: the second call does nothing when the flag is true
  - `model unreachable leaves flag false`
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4: Regression.** The v26 sentinel test still passes with `topicSweepDone` added. The sweep never touches `papers`, `annotations`, `provocations`, `dumps` or `vault`; assert that with the sentinels.
- [ ] **Step 5:** Gate, then run `/verify` (`.claude/skills/verify/SKILL.md`). Seed a "Focus workspace" `chrome-extension://` entry, an off-topic YouTube entry and an on-topic paper. After load, Continue shows only the paper and on-topic items, with zero console errors. Commit `One-time topic sweep, model-confirmed only`.
