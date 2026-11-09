# Reader

**A quiet companion to [alphaXiv](https://www.alphaxiv.org): your paper shelf,
and a reader that asks instead of tells and blocks what pulls you away.**

The failure it is built around is not that papers are hard. It is that another
tab pulls you off the paper. Success is finishing twenty minutes with a paper
and being able to explain it to a friend: the problem, the key trick, and why
it works, even if you never read it end to end.

The extension is written in Rust and compiled to WebAssembly, on a fork of
[oxichrome](https://github.com/0xsouravm/oxichrome) with a
[Leptos](https://leptos.dev) UI. pdf.js and KaTeX stay JavaScript.

Screenshots are frames from the end-to-end demo (`e2e/demo.e2e.ts`), which drives the real extension.

![The new tab: papers in progress, today's to-dos from the brain dump, and Hacker News](docs/screenshots/newtab.jpg)

![Reading a paper: Talk it through, a Socratic tutor you answer out loud](docs/screenshots/reader-talk.jpg)

![Any webpage, with the side panel: Listen reads it aloud section by section](docs/screenshots/sidebar-webpage.jpg)

![A YouTube video, with the side panel: Gemini's notes, timestamped](docs/screenshots/sidebar-youtube.jpg)

![The lexicon: every saved term, linked across papers](docs/screenshots/lexicon.jpg)

---

## What it does

### Your library is alphaXiv's

Sign in to alphaXiv from Settings and your folders become the shelf. alphaXiv
is the master copy; the extension mirrors it and adds only what alphaXiv does
not keep: how far you got, where you stopped, and when you last read. The
mirror refreshes when a new tab or the papers page opens, and on a timer.

Only arXiv papers are supported. Other PDFs open in Chrome's own viewer.

### The reader

arXiv PDF links open in the extension's reader instead of Chrome's viewer, with
alphaXiv one menu item away.

- **The chrome sleeps.** The toolbar fades a moment after you start reading and
  comes back at the top edge, on scroll-up, or with keyboard focus.
- **Status without noise.** A capsule under the page shows the page and the
  minutes left; click it for page jump and zoom.
- **Section rail.** The outline rests as tick marks on the left edge, the
  current section lit.
- **Focus line.** Press F and a reading band holds your place.
- **Figure mentions jump.** "Figure 3" in the text goes to the figure, and a
  Back button returns you to where you were reading. Citations and section
  links jump the same way.
- **Highlights and sticky notes**, in four colours, with a notes list to jump
  between them.
- **Find in document**, and **resume where you left off**: the exact page and
  scroll position, saved the moment you switch or close the tab.
- **Explain it back**: unfinished explanations save automatically on this
  device, separately for each paper, even when you close the panel or reload.
- **Click a word to define it.** You write your guess from the sentence around
  it first; then Claude Haiku says what it means in this paper. This is the
  one place the reader tells rather than asks. Keep the definition as a note on
  the term, or not.

### A reading session

While a reader tab is open, the sites on your block list redirect to a quiet
page that names what you were reading. Closing the last reader tab lifts the
block. Blocking is `declarativeNetRequest`, so it holds across service-worker
restarts.

### The new tab

- **Continue reading**: the paper you read last, opened where you stopped.
  Queued and completed papers are tucked into expandable sections.
- **Focus rounds**: start from a task on the board, or choose up to three
  for 25 minutes. Task edits and completion stay in sync with the round.
  An optional YouTube link allows that study video while other videos stay
  blocked. News stays hidden during focus and reading sessions.
- **Brain dump**: type what is looping; Claude Haiku hands it back a little
  lighter, and the words go into an encrypted vault (RSA-OAEP and AES-GCM,
  unlocked by your passphrase or a recovery code). The new tab never shows a
  dump; the dumps page does, once unlocked.
  The box shows when vault setup is still needed; submissions remain
  unencrypted until setup finishes. Extracted tasks can be edited on the
  board or undone together.
- **Activity**: a year of reading and focus sessions as a heatmap.

### Design

Six palettes, including dark Grid, with tokens tested for AAA text contrast
(7:1). Reader panels use opaque surfaces; notes and settings use larger body
text. Body text is Atkinson Hyperlegible.
Motion is stilled under Reduce Motion; translucency follows Reduce
Transparency.

---

## Privacy

There is no account of the extension's own. It talks to:

- **alphaXiv**, once you sign in (OAuth with PKCE), for your library;
- **arXiv**, to fetch the PDFs you open;
- **Claude**, with your own key, only for a definition you ask for or a brain
  dump you submit.

Everything else stays in `chrome.storage` on your machine.

---

## Installation

### You cloned this repo

Double-click **`install.command`** (macOS; on Linux `sh install.command`) or
**`install.bat`** (Windows). It checks for Node.js and Rust, builds, opens
`chrome://extensions`, and shows the folder to load. Chrome allows installs
from outside the Web Store only through Developer mode → **Load unpacked**.

### Without building

```sh
npm run package   # → release/install-reader.command + release/reader-extension-v*.zip
```

Send either file. The `.command` unpacks itself and walks the recipient through
Load unpacked; the zip works on any OS. No Node, npm or Rust needed to install.

### From source

Needs Node.js 22 and Rust (stable, from [rustup](https://rustup.rs)).

```sh
rustup target add wasm32-unknown-unknown
npm install
npm run build     # the extension → rust/ext/dist/chromium, plus the brain MCP server
```

The first build installs the matching `wasm-bindgen-cli`. Then
`chrome://extensions` → Developer mode → Load unpacked → `rust/ext/dist/chromium`.

---

## Development

```sh
npm run build:ext   # the extension only
npm run test:rust   # cargo test, clippy (native and wasm, -D warnings), rustfmt
npm test            # stylesheet guards, cut-features guard, brain MCP tests
npm run typecheck   # the TypeScript that remains (e2e, brain MCP, tests)
npm run test:e2e    # the browser suite against the built extension (Playwright)
npm run check       # all of the above
```

A pre-commit hook (`.githooks/pre-commit`, installed by `npm install`) runs
`check:fast`: typecheck, unit tests and the Rust checks. CI runs everything,
including the browser suite.

### Project layout

```
rust/
  core/        the rules, pure Rust, tested natively: storage types and
               migrations, alphaXiv OAuth and sync plans, the MCP client's
               protocol, focus rules, annotations, Markdown, the vault format
  ext/         the extension crate (#[oxichrome::extension])
    src/worker/   the background worker: messages, the reading session,
                  PDF redirects, alphaXiv sign-in and sync
    src/pages/    Leptos pages: newtab, papers, reader, options, blocked, dumps
    js/           the hand-written worker shim and the pdf.js / KaTeX bridges
    css/          the stylesheets, and the tests that hold them to the
                  design system (AAA contrast, tokens only, motion)
  NOTES.md     what each phase of the port taught, file by file
vendor/oxichrome/   the extended oxichrome fork (pages, newtab, manifest patches)
e2e/                Playwright suite, run against the built extension
mcp/brain/          the brain MCP server (Node; not part of the extension)
tests/              repository-wide guards (cut features stay cut)
```

### The design system

Every colour, space, radius and duration is a token in `rust/ext/css/theme.css`.
`rust/ext/css/designSystem.test.ts` fails the build on a raw colour, radius or
shadow anywhere else; `theme.test.ts` checks every text/surface pair for 7:1;
`motion.test.ts` checks that every spring is stilled under Reduce Motion.

---

## Permissions

| Permission | Why |
|---|---|
| `storage` | Everything is stored locally |
| `alarms` | The periodic alphaXiv sync |
| `declarativeNetRequest` | Blocking during a reading session, and sending arXiv PDFs to the reader |
| `identity` | Signing in to alphaXiv (`launchWebAuthFlow`) |
| `<all_urls>` | Fetching PDFs for the reader, and reaching alphaXiv and Claude from the worker |

---

## License

MIT, see [LICENSE](LICENSE).
