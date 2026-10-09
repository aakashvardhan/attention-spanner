# History feeds, muted topics, same-story grouping

*2026-10-08. Ideas taken from ThariqS/ai-newtab, kept local-first.*

## Why

ai-newtab treats browsing history as the signal for what someone follows, then
builds a homepage from it by scraping signed-in pages and sending them to
Claude. We take the signal and leave the cloud: `llm/route.ts` already rules
that any web page counts as private, and an LLM-written layout would fight the
fixed edition layout and the design-token lint.

Three gaps in this extension the idea fills:

1. A feed can only be added by pasting its exact feed URL.
2. Triage learns from what you finish but never from what you would rather not
   see.
3. One story carried by three feeds takes three of the triage card's five slots.

## 1. Feed suggestions from history

**Where:** Options, the "Sample Feeds" section becomes "Suggested feeds". The
static sample chips stay below the new part.

**Flow:**

1. Button: *Suggest from my history*.
2. On click, `chrome.permissions.request({ permissions: ['history'] })`.
   `history` is added to `optional_permissions` in the manifest, never to
   `permissions`, so install shows no new warning. Denied: one-line message,
   nothing else changes.
3. `chrome.history.search({ text: '', startTime: now - 7d, maxResults: 10000 })`
   in the options page.
4. `rankDomains(items, now, days)` (pure): group http(s) items by hostname with
   `www.` stripped, drop domains under 2 visits, score
   `0.4·min(visits/50,1) + 0.3·recency + 0.2·min(pages/10,1) + 0.1·min(perDay/5,1)`
   (ai-newtab `lib/history.ts`), sort descending.
5. Drop domains whose hostname matches a followed feed's hostname; take the top
   12.
6. For each, `fetch('https://<domain>/', { credentials: 'omit' })`, then
   `feedLinks(html, baseUrl)` (pure): every `<link>` with `rel` containing
   `alternate` and `type` of `application/rss+xml` or `application/atom+xml`,
   `href` resolved against the base. First link per domain. Fetch failures are
   skipped silently; the result line reports how many sites were checked.
7. Render a chip per hit: `lwn.net · 14 visits this week`, using the existing
   `sample-feed` class. Click calls the existing `addFeed`, which validates
   through `VALIDATE_FEED`.

Nothing is stored. No background scan, no new-tab prompt.

**Add Feed accepts a site URL.** When `VALIDATE_FEED` fails for the typed URL,
`addFeed` fetches it as a page, runs `feedLinks`, and retries with the first
link found. Feedback says which feed was added.

**Module:** `src/shared/feedDiscovery.ts` holds `rankDomains` and `feedLinks`.

## 2. Muted topics

- `Settings.mutedTopics: string[]`, default `[]`. A new default is enough:
  `getSettings` spreads defaults over the stored object.
- Options › New Tab: a textarea *Hide from your feeds*, one topic per line,
  committed on blur (the `NewTabSection` pattern).
- `isMuted(item, topics)` (pure, in `llm/triage.ts`): case-insensitive
  whole-word match of any topic against title, snippet or source. Multi-word
  topics match as a phrase.
- `TriageCard` filters unread items through it before ranking. When anything
  was muted, the card's note reads `N muted`.
- Keyword only. Embedding-based muting needs a measured threshold; revisit if
  keywords miss too much.

## 3. Same-story grouping

- `Pick` gains `also: FeedItem[]` (empty by default).
- `clusterPicks(picks, vectorOf, min)` (pure, in `llm/triage.ts`): walk picks in
  rank order; a pick whose cosine to an earlier leader is at least `min` joins
  that leader's `also`, otherwise it becomes a leader. Picks without a vector
  are always leaders.
- `SAME_STORY_MIN = 0.85`, marked `ponytail:` as an uncalibrated knob for
  nomic-embed-text.
- `TriageCard`: rank 15 → cluster → Laya rerank of leaders → 5. With Ollama off
  the newest-first path skips clustering.
- Row meta: `Ars Technica +2 sources`. Opening the row also marks every `also`
  item read, so the siblings do not resurface.

## 4. Cleanup (main checkout, untracked files only)

- Delete the 90 `* 2.*` Finder duplicates. 82 are identical; the 8 that differ
  are Oct 2 snapshots of files last edited Oct 3–4.
- Delete `prof-izwfGL/`, `prof-oLcejq/` (Chrome profiles from verify runs) and
  root `newtab.png`, `reader.png`, `reader-zoomed.png` (README uses
  `docs/screenshots/`).
- `.gitignore`: add `prof-*/`.

## Out of scope

Signed-in scraping, cloud calls, model-written layouts, build progress UI,
scheduled rebuilds, per-row "not interested" buttons, persisted dismissals.

## Testing

Unit: `rankDomains` (threshold, grouping, ordering, non-http dropped),
`feedLinks` (rss + atom, relative href, ignores non-feed alternates),
`isMuted` (whole word, phrase, source), `clusterPicks` (joins above threshold,
leaders keep order, missing vectors). Then `/verify`: Options renders the
suggestions section; new tab triage card still renders.
