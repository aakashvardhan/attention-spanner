# ADHD Reader

A Chrome extension that turns an RSS reader into a full attention-management
system. It helps you finish what you start, capture thoughts before they
vanish, and build the habits that keep you on track — all without sending
your data anywhere.

Built with Manifest V3, React, Vite, and TypeScript.

## Why this exists

Standard RSS readers assume you'll read what you save. In practice, articles
pile up unread, tasks get lost the moment you think of them, and focus breaks
the second a new tab opens. ADHD Reader closes that gap: it tracks what you
start, nudges you back to it, and rewards you for following through.

## Features

### Reading & tasks
- **RSS reader** — feeds, unread badge, filtering, auto-refresh.
- **Quick capture** — press `⌘⇧Y` / `Ctrl+Shift+Y` anywhere in Chrome to open
  a capture window, type a task, hit Enter. Nothing is lost to a fleeting
  thought.
- **Reading progress & resume** — scroll position is tracked per article; the
  popup shows a "Continue reading" pick-up point.
- **Tab-switch nudges** — a gentle reminder fires when you leave an article
  half-read, with anti-spam gates (delay, cooldown, per-article cap, dismiss).
- **YouTube tracking** — long videos (≥15 min, configurable) are auto-tracked
  with resume-at-timestamp and abandonment nudges. Watch time accrues even in
  a background tab, so podcast-style listening isn't penalized. Shorts and
  live streams are ignored.

### Focus & habits
- **Focus Mode** — one-shot blocks (25/50/90 min or custom) or pomodoro
  cycles (default 50:10) that block a configurable site list via
  `declarativeNetRequest`. Enforcement survives service-worker restarts and
  browser relaunches. Ending early requires a 5-second hold.
- **Pomodoro polish** — the toolbar badge becomes a live countdown during
  focus phases, and new tabs switch to a dark focus theme with a banner
  countdown. Optional Flowtunes integration opens ambient music automatically.
- **Reading sprints & streaks** — daily streaks with a GitHub-style activity
  calendar on the dashboard.
- **Gym check-ins** — one-tap "I went today" logging, with a weekly-goal
  streak that survives rest days.
- **Hyperfocus guardrails** — a gentle notification after extended unbroken
  engagement (default 90 min), so a deep-focus session doesn't turn into a
  lost afternoon.
- **Ignition mode** — for tasks you're avoiding, an AI-suggested "first
  tiny action" kicks off a 5-minute focus session to break the inertia.

### Gamification
- Unified XP and levels across every habit — reading, tasks, gym, video,
  flashcards, and focus sessions all feed the same progression system.
- A 16-badge trophy case and auto-derived weekly quests with bonus XP.
- Mystery chests — a small chance of bonus XP on task completion.
- Streak insurance — earn freeze tokens that protect a streak through a
  missed day.

### AI (on-device, no API key)
- **Brain dump** — type raw, unstructured thoughts and Chrome's built-in
  Gemini Nano (on-device Prompt API) turns them into organized bullets and
  proposed tasks. Nothing leaves your machine. Dumps are saved as plain notes
  *before* structuring, so a closed window never loses your thoughts. Task
  creation is review-first — nothing enters your list until you confirm.

### Flashcards
- Anki-style spaced repetition (SM-2 algorithm) with basic and cloze-deletion
  cards, generated from your notes. Includes learning steps, lapses, a
  30-day review chart, and daily new-card limits.

### Dashboard & organization
- A **new-tab dashboard** replaces Chrome's default new tab with tasks,
  continue-reading, streak heatmap, activity calendar, bookmarks, and more —
  laid out in a drag-and-drop grid you can customize and resize.
- **Bookmarks & link groups** — a curated speed-dial, independent of Chrome's
  own bookmarks, addable from the popup, dashboard, or a right-click context
  menu.
- **Dark mode** — full light/dark/system theming across every page.
- **Notion sync (one-way)** — push links, brain dumps, tasks, and a reading
  log to your own Notion databases via an integration token.

## Installation

```bash
npm install
npm run build     # typecheck + production build into dist/
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder

If you have an older RSS Feed Reader extension installed, disable it — this
one replaces it and does not share storage across extension IDs.

## Development

```bash
npm run dev        # dev server with HMR (@crxjs/vite-plugin)
npm test           # vitest — 182 unit tests
```

## Requirements for on-device AI

Brain dump and Ignition mode use Chrome's built-in Prompt API (Gemini Nano),
which needs:
- Chrome 138+
- ~22 GB free disk space
- A 4 GB-VRAM GPU or 16 GB RAM

The first use triggers a one-time model download, with progress shown in the
UI. Check status at `chrome://on-device-internals`. On unsupported hardware,
brain dumps still save as plain notes.

To force eligibility on borderline hardware, enable these flags:
`chrome://flags/#optimization-guide-on-device-model` (Enabled
BypassPerfRequirement) and `chrome://flags/#prompt-api-for-gemini-nano`.

## Architecture

- **Service worker** (`src/background/`) owns all storage writes; every
  read/write from the UI goes through a message router, so state stays
  consistent across popup, dashboard, and content scripts.
- **UI reactivity** is driven entirely by `chrome.storage.onChanged` — no
  polling.
- **Content scripts** (`src/content/`) are bundled separately via esbuild
  (not the Vite/crxjs pipeline), since `chrome.scripting.executeScript`
  can't inject ES modules. They handle reading-progress tracking, YouTube
  video tracking, and an in-page time-awareness pill.
- **Pure logic modules** (`src/shared/`) — spaced repetition, XP curves,
  badge rules, streak math, focus-block rules — are dependency-free and
  fully unit-tested (182 tests via Vitest).
- **Blocking** uses `declarativeNetRequest`, so Focus Mode enforcement is
  browser-level and survives service-worker termination.

## Permissions

| Permission | Why |
|---|---|
| `storage` | All extension state (feeds, tasks, streaks, settings) |
| `alarms` | Scheduled reminders, digests, badge ticks |
| `notifications` | Task reminders, streak/badge alerts |
| `scripting` | Injecting the reading/video trackers |
| `declarativeNetRequest` | Focus Mode site blocking |
| `contextMenus` | Right-click "Bookmark in ADHD Reader" |
| `<all_urls>` (host) | Tracking reading/video progress on any site; Notion API calls |

## Notifications on macOS

Task reminders use Chrome's notification API. If nothing appears, check
**System Settings → Notifications → Google Chrome** — Chrome silently
no-ops when the OS-level permission is off.

## License

MIT — see [LICENSE](LICENSE).
