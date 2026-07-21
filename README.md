# Reader

**An RSS reader rebuilt as a full attention-management system for ADHD brains.**

Reader helps you finish what you start, capture thoughts before they vanish,
and build the habits that keep you on track — everything runs locally, and
your data never leaves your machine.

Built on Manifest V3 with React 19, Vite, and TypeScript.

![Reader dashboard](docs/screenshots/dashboard.png)

---

## Table of contents

- [Why this exists](#why-this-exists)
- [Features](#features)
- [Installation](#installation)
- [Development](#development)
- [On-device AI requirements](#on-device-ai-requirements)
- [Architecture](#architecture)
- [Permissions](#permissions)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Why this exists

Standard RSS readers assume you'll read what you save. In practice, articles
pile up unread, tasks get lost the moment you think of them, and focus breaks
the second a new tab opens. Reader closes that gap: it tracks what you start,
nudges you back to it, and rewards you for following through.

Everything runs locally. On-device AI uses Chrome's built-in Gemini Nano — no
API keys, no external calls (an optional bring-your-own Gemini API key can
handle harder assistant queries).

---

## Features

### Reading & tasks
- **RSS reader** — feeds, unread badge, filtering, and auto-refresh.
- **Quick capture** — press `⌘⇧Y` / `Ctrl+Shift+Y` anywhere in Chrome to open a
  capture window, type a task, hit Enter. Nothing is lost to a fleeting thought.
- **Reading progress & resume** — scroll position is tracked per article; the
  popup surfaces a "Continue reading" pick-up point.
- **Tab-switch nudges** — a gentle reminder fires when you leave an article
  half-read, gated against spam (delay, cooldown, per-article cap, dismiss).
- **YouTube tracking** — long videos (≥15 min, configurable) are auto-tracked
  with resume-at-timestamp and abandonment nudges. Watch time accrues even in a
  background tab, so podcast-style listening isn't penalized. Shorts and live
  streams are ignored.
- **Paper tracking** — a dedicated reading log for academic papers and
  long-form documents.

### Focus & habits
- **Focus Mode** — one-shot blocks (25 / 50 / 90 min or custom) or pomodoro
  cycles (default 50:10) that block a configurable site list via
  `declarativeNetRequest`. Enforcement survives service-worker restarts and
  browser relaunches. Ending early requires a 5-second hold.
- **Pomodoro polish** — the toolbar badge becomes a live countdown during focus
  phases, and new tabs switch to a dark focus theme with a banner countdown.
  Optional Flowtunes integration opens ambient music automatically.
- **Reading sprints & streaks** — daily streaks with a GitHub-style activity
  calendar on the dashboard.
- **Gym check-ins** — one-tap "I went today" logging, with a weekly-goal streak
  that survives rest days.
- **Hyperfocus guardrails** — a gentle notification after extended unbroken
  engagement (default 90 min), so a deep-focus session doesn't turn into a lost
  afternoon.
- **Ignition mode** — for tasks you're avoiding, an AI-suggested "first tiny
  action" kicks off a 5-minute focus session to break the inertia.

### Gamification
- Unified XP and levels across every habit — reading, tasks, gym, video,
  flashcards, and focus sessions all feed one progression system.
- A 16-badge trophy case and auto-derived weekly quests with bonus XP.
- **Mystery chests** — a small chance of bonus XP on task completion.
- **Streak insurance** — earn freeze tokens that protect a streak through a
  missed day.

### On-device AI (no API key)
- **Brain dump** — type raw, unstructured thoughts and Chrome's built-in Gemini
  Nano (on-device Prompt API) turns them into organized bullets and proposed
  tasks. Nothing leaves your machine. Dumps are saved as plain notes *before*
  structuring, so a closed window never loses your thoughts. Task creation is
  review-first — nothing enters your list until you confirm.

### Flashcards
- Anki-style spaced repetition (SM-2) with basic and cloze-deletion cards
  generated from your notes. Includes learning steps, lapses, a 30-day review
  chart, and daily new-card limits.

### Dashboard & organization
- **New-tab dashboard** — replaces Chrome's default new tab with tasks,
  continue-reading, streak heatmap, activity calendar, bookmarks, and more, laid
  out in a drag-and-drop grid you can customize and resize.
- **Bookmarks & link groups** — a curated speed-dial, independent of Chrome's
  own bookmarks, addable from the popup, dashboard, or a right-click context
  menu.
- **Dark mode** — full light / dark / system theming across every page.
- **Assistant (Jarvis)** — a chat card, popup tab, and `⌘K` command palette that
  answer questions from your own data and run actions ("add a task to…", "start
  a 25-minute focus"). On-device Gemini Nano first, optional Gemini API key
  (yours, entered in Options) for harder queries; optional push-to-talk voice
  input and spoken replies via the browser's built-in speech synthesis.

---

## Installation

### Easiest — you cloned this repo (no commands to type)

After you download or `git clone` this project, just run the installer for your
system. It builds the extension for you and opens Chrome to the last step.

- **macOS** — double-click **`install.command`** in Finder.
- **Windows** — double-click **`install.bat`** in File Explorer.
- **Linux** — run `sh install.command`.

The only thing it needs is [Node.js](https://nodejs.org) (download the "LTS"
button once) — the installer checks for it and links you there if it's missing.
When it finishes, Chrome opens to `chrome://extensions`: turn on **Developer
mode**, click **Load unpacked**, and pick the `dist` folder it points you to.

### Without building (share with anyone)

```bash
npm run package   # → release/install-reader.command + release/reader-extension-v1.0.0.zip
```

Send people **one file**:

- **macOS / Linux** — `install-reader.command`. Double-click (macOS) or
  `sh install-reader.command` (Linux). It self-extracts the prebuilt extension
  to `~/ReaderExtension`, opens `chrome://extensions`, and prints the one
  remaining step: enable **Developer mode** → **Load unpacked** → pick the
  `ReaderExtension` folder. No node/npm needed. Chrome doesn't allow installs
  outside the Web Store, so that one click can't be automated.
- **Windows** — the `.zip`: extract it, then Load unpacked the extracted folder.

### From source

```bash
npm install
npm run build     # typecheck + production build into dist/
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder

> If you have an older RSS Feed Reader extension installed, disable it — this
> one replaces it and does not share storage across extension IDs.

---

## Development

```bash
npm run dev        # dev server with HMR (@crxjs/vite-plugin)
npm run build      # typecheck + production build
npm run typecheck  # tsc --noEmit
npm test           # vitest unit tests
```

---

## On-device AI requirements

Brain dump, Ignition mode, and the assistant use Chrome's built-in Prompt API
(Gemini Nano), which needs:

- Chrome 138+
- ~22 GB free disk space
- A 4 GB-VRAM GPU or 16 GB RAM

The first use triggers a one-time model download, with progress shown in the
UI. Check status at `chrome://on-device-internals`. On unsupported hardware,
brain dumps still save as plain notes.

To force eligibility on borderline hardware, enable these flags:
`chrome://flags/#optimization-guide-on-device-model` (Enabled
BypassPerfRequirement) and `chrome://flags/#prompt-api-for-gemini-nano`.

For assistant queries too long or hard for Nano, you can paste your own
Gemini API key in **Options → Assistant** — it's stored locally and used only
for those calls. Leave it blank to stay fully on-device.

---

## Architecture

- **Service worker** (`src/background/`) owns all storage writes; every
  read/write from the UI goes through a message router, so state stays
  consistent across popup, dashboard, and content scripts.
- **UI reactivity** is driven entirely by `chrome.storage.onChanged` — no
  polling.
- **Content scripts** (`src/content/`) are bundled separately via esbuild (not
  the Vite / crxjs pipeline), since `chrome.scripting.executeScript` can't
  inject ES modules. They handle reading-progress tracking, YouTube video
  tracking, and an in-page time-awareness pill.
- **Pure logic modules** (`src/shared/`) — spaced repetition, XP curves, badge
  rules, streak math, and focus-block rules — are dependency-free and fully
  unit-tested via Vitest.
- **Blocking** uses `declarativeNetRequest`, so Focus Mode enforcement is
  browser-level and survives service-worker termination.

### Project layout

```
src/
  background/   Service worker: routing, feeds, tasks, focus, …
  content/      Injected trackers (reading, video, time pill)
  pages/        popup, newtab, options, capture, flashcards, papers, blocked
  shared/       Dependency-free pure logic + storage helpers
```

---

## Permissions

| Permission | Why |
|---|---|
| `storage` | All extension state (feeds, tasks, streaks, settings) |
| `alarms` | Scheduled reminders, digests, badge ticks |
| `notifications` | Task reminders, streak / badge alerts |
| `scripting` | Injecting the reading / video trackers |
| `declarativeNetRequest` | Focus Mode site blocking |
| `contextMenus` | Right-click "Bookmark in Reader" |
| `<all_urls>` (host) | Tracking reading / video progress on any site |

---

## Troubleshooting

**Notifications on macOS.** Task reminders use Chrome's notification API. If
nothing appears, check **System Settings → Notifications → Google Chrome** —
Chrome silently no-ops when the OS-level permission is off.

**AI unavailable.** Confirm your hardware meets the
[on-device AI requirements](#on-device-ai-requirements) and check model status
at `chrome://on-device-internals`. Brain dumps still save as plain notes on
unsupported hardware.

---

## License

MIT — see [LICENSE](LICENSE).
