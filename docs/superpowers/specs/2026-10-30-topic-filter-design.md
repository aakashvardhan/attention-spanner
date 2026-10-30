# Topic filter for Continue

Date: 2026-10-30. Branch: `minimal-revamp`, on top of `f913918`.

## Why

Continue is meant to answer one question: "what was I in the middle of that I care about?" Today it records:

- every YouTube video over the length gate, whatever it is about
- every page you open from News or with "read this", whatever it is about
- the extension's own new tab, which is why "Focus workspace" appears in Reading

The user tracks AI, robotics and reinforcement learning. Anything else in Continue is noise.

## Goals

- Continue (Reading and Watching) holds only what is on the user's topics.
- Topics are a short editable list in Settings. It starts as AI, robotics and reinforcement learning.
- The extension never records its own pages (`chrome-extension://`, `chrome://`).
- Existing off-topic entries and extension-page entries are cleared once.

## Non-goals

- Filtering News. It already has its own interest ranking and muted topics.
- Filtering papers. A paper is in the library because the user put it there.
- A per-item "keep anyway" control. Add it later if the filter misfiles.

## Anti-goals (a failure even if it works)

- An on-topic item silently dropped while the user is reading or watching it. Misfiling toward keeping is acceptable; misfiling toward dropping is not.
- A model call on every new tab, or on every heartbeat. Classification happens at most once per URL or video.
- Any network call to the cloud to classify. Classification stays on device (keywords, then local Ollama if configured). This keeps the existing privacy rule: browsing history never leaves the machine.
- Deleting papers, annotations, provocations or anything outside `readingProgress`.

## Decided by the user

- Cleanup of existing entries is the cautious option: only extension pages are removed outright, and anything else needs a local-model "off topic" verdict to be deleted.
- The filter applies to both YouTube videos and web pages.
- Default topics: AI, robotics, reinforcement learning.
- "Focus workspace" is irrelevant and must go.

## How it works

### 1. Never track extension pages

- **Pages:** `registerOpenedTab`, `handleProgressUpdate`, and every other writer of `readingProgress` refuse any URL that isn't `http(s):`.
- **Read this:** the shortcut and the context menu do nothing on the extension's own pages.
- **Cause to confirm:** "Focus workspace" is the `<title>` of `src/pages/newtab/index.html`. The builder finds the path that recorded it, most likely "read this" fired on the new tab, and closes it at the shared writer, not only at that caller.

### 2. Topics setting

- New setting `trackTopics: string[]`, default `['AI', 'robotics', 'reinforcement learning']`.
- It is edited in Options under "Your Feeds" or a small "Continue" section, as a comma-separated or one-per-line field.
- The setting is read through `useSettings()`.
- An empty list means "track everything", which is today's behaviour, so the filter can be switched off.

### 3. The classifier: `onTopic(text, topics, settings) → Promise<boolean>`

`text` is the title, plus the channel name for videos or the hostname for pages. The classifier works in two stages.

1. **Keywords first.** They are instant, free and predictable.
   - Each default topic carries a built-in synonym set. Seed them from the deleted `videoCategory.ts` rules (`git show 0c70025:src/shared/videoCategory.ts`, the 'Robotics' and 'AI' patterns), plus reinforcement learning terms: RL, PPO, DQN, policy gradient, Q-learning, reward, MDP, bandit, actor-critic.
   - A user-added topic with no synonym set matches as whole words, ignoring case.
   - Any match means on topic.
2. **Local model second.** This stage runs only when no keyword matched and the user has Ollama configured: `settings.ollamaUrl` plus the existing `settings.ollamaEmbedModel`, the same model recall and triage use.
   - Embed the text and the topic list, and keep the item if cosine similarity to any topic is ≥ a threshold.
   - Reuse the existing embed path and vector cache in `src/shared/llm/`.
   - The threshold is measured, not guessed. Build a labelled set of 30–40 titles (on and off topic) in a test fixture, then pick the value that keeps every on-topic title.
3. **No model available:** the keyword verdict stands.

The verdict is computed once per normalized URL or videoId and cached, so a later visit or heartbeat never re-asks.

### 4. Where the gate sits

- **Videos.** In `handleVideoReady`, next to the existing length gate. The tracker's ready message must carry the title and channel; today it sends only `videoId` and duration. An off-topic video returns `track: false`, so nothing is ever stored.
- **Pages.** `readingProgress` entries are created in `handleProgressUpdate` (src/background/tracking.ts), not in `registerOpenedTab`, which only fills the session `trackedTabs` map. The gate sits at that creation point and covers every automatic creation: pages opened from News, and known feed URLs reopened by typing or tab restore.
- **"Read this" (shortcut or context menu).** Always tracked, even when off topic, because the user asked for this exact page. `registerOpenedTab` records an `explicit: true` flag in `trackedTabs` for these, and the gate skips flagged tabs. This is Claude's call; see below.
- **No title yet.** Classify on the first progress update that carries a title. If none ever arrives, keep the entry, because misfiling toward keeping is the safe side.
- **Waiting on the model.** Keywords decide instantly. When a keyword misses and Ollama is configured, `handleVideoReady` and the page gate wait up to 1.5 s for the embedding verdict. On timeout the item is kept; if the late verdict is off topic, the entry is removed then. Nothing on-topic is ever dropped by a timeout.
- **Papers.** Never gated.

### 5. One-time cleanup (decided by the user: the cautious option)

The cleanup never deletes an item on keywords alone. It runs in two steps:

1. **In `migrate()`, under `version < 26` (schema v26).** Remove `readingProgress` entries whose URL isn't `http(s):`. This removes "Focus workspace" and any other extension page. Nothing else is touched here.
2. **One background pass after install or update, outside `migrate()`.** For each remaining non-paper entry, run the full classifier against `settings.trackTopics` (or the defaults if unset).
   - Delete an entry only when the keywords miss **and** the local model is available **and** the model says it is off topic.
   - If the model is not configured or unreachable, keep everything.
   - Entries updated in the last 24 hours are always kept.
   - The pass runs once. Record completion in a local flag so it never repeats.

Kept data otherwise stays untouched. Add the existing full-profile sentinel test for v26. Add a unit test for the pass, covering three cases:
- Keyword miss with no model: kept.
- Keyword miss with a model "off topic" verdict: removed.
- Recent entry: kept.

## Constraints

- The project rules from the minimal revamp still apply:
  - tokens-only CSS
  - read settings through `useSettings()`
  - the cumulative dead-key sweep
  - the cut-features guard
  - unit, edge and regression tests at each step
  - e2e for anything UI-facing
- `npm test`, typecheck, build, the e2e suite and `/verify` all pass.

## Claude's calls (flag if wrong)

- Off-topic items are never stored, rather than stored and hidden.
- "Read this" always tracks, because it is an explicit request. Only automatic tracking is filtered (YouTube, and pages opened from News).
- An empty topic list turns the filter off.
- The local model only ever widens what is kept; it never removes a keyword match.

## Left to the builder

- Exact synonym lists, beyond the seeds above.
- Where the topics field sits in Options, and its copy.
- The embedding threshold value, measured on the fixture.
- How the verdict cache is keyed and stored. It is a cache, so loss is harmless; add it to the session or a local cache key.
