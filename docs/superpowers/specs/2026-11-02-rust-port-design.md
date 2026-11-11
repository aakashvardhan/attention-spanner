# Rust/WebAssembly port (oxichrome, extended)

> **Status (2026-11-10): done**; the TypeScript tree is deleted. Two things were built
> differently from this spec. The layout is `rust/core` (the pure rules) and `rust/ext`
> with `src/worker/`, `src/pages/`, `js/` and `css/` (README, Project layout), not the
> `src/chrome/`, `src/background/` and `assets/` below. And there are no
> `wasm-bindgen-test` tests: the extern-bound code is covered by the browser suite
> (`e2e/`).

## Intent
Learn Rust and WebAssembly on a real project by porting this extension to Rust,
compiled to wasm, built on [oxichrome](https://github.com/0xsouravm/oxichrome)
(v0.2.1, Leptos 0.8 UI). Claude writes the code; the user learns by reading.
Each phase ends with a `rust/NOTES.md` entry naming the Rust and wasm ideas it
used (ownership across async, `wasm_bindgen` externs, `serde` with JS values,
Leptos signals, proc macros…), pointing at the files that show them.

Steps 4–6 of the papers-library spec (reader questions and explain-back, the
bookshelf, the new tab) are built directly in Rust once the port reaches them.
The TypeScript tree is frozen at `210bcfc` (step 3) and deleted when the Rust
build passes the full browser suite.

## Non-goals
- Rewriting pdf.js or KaTeX. No Rust equivalent has pdf.js's text layer; both
  stay JS, bundled once and called through `wasm_bindgen` externs.
- Porting the brain MCP server (`mcp/brain`, Node). It is not part of the
  extension; it stays TypeScript.
- Changing behaviour or looks during the port. The port is done when the
  existing browser suite and screenshot baselines pass against the Rust build.

## What oxichrome lacks (from its source, 2026-11-02)
It wraps `storage.local`, `tabs` (query/create/sendMessage/onUpdated/onActivated)
and `runtime` (getURL/sendMessage/onInstalled/onMessage), and generates one
popup, one options page, a background worker and content scripts from one
crate. Its manifest is a fixed struct.

| Needed | Status | Plan |
|---|---|---|
| `chrome_url_overrides.newtab` | no manifest field | **fork**: add field |
| Extra pages (reader, papers, blocked, dumps) | only popup/options | **fork**: `#[oxichrome::page(name = "...", newtab, web_accessible)]` |
| `action` with no popup + `action.onClicked` | popup assumed | **fork**: optional popup |
| CSP `wasm-unsafe-eval`, web_accessible_resources | fixed | **fork**: configurable |
| Static assets (CSS, fonts, icons, pdf.js bundle) | partial | **fork**: copy an `assets/` dir |
| `declarativeNetRequest`, `identity`, `alarms`, `tabs.update/get/onRemoved`, `windows.update`, `storage.session` | missing | our own `wasm_bindgen` externs in the app crate (no fork needed) |

The fork lives in `vendor/oxichrome` (git subtree), each change a small commit
written to be upstreamable. Pushing the fork or opening upstream PRs is the
user's call, later.

## Layout
```
rust/
  Cargo.toml            workspace
  core/                 pure logic, no wasm types: `cargo test` natively
  ext/                  the extension crate (#[oxichrome::extension]):
    src/chrome/         externs for the APIs oxichrome lacks
    src/background/     worker: router, reading session, alphaXiv, PDF rules
    src/pages/          Leptos: newtab, options, papers, reader, blocked, dumps
    assets/             the existing CSS, fonts, icons; js/ for pdf.js + KaTeX
vendor/oxichrome/       the fork
```
`core` holds everything that is a rule rather than an effect: types, storage
schema and migrations, alphaXiv OAuth/reply parsing/merge/push plan, the
session rules, PDF/paper helpers, annotations, heatmap, reading aids,
Markdown. Pure Rust is the fastest place to learn the language and the
cheapest to test.

## How the hard parts work
- **Messaging and storage**: one serde `Message` enum, the TS union
  mirrored, tagged on `type`, so JSON on the wire is unchanged. Storage keys and
  shapes stay byte-compatible, so a profile moves from TS to Rust without
  migrating.
- **alphaXiv MCP**: a small JSON-RPC client over Streamable HTTP (initialize,
  the `mcp-session-id` header, JSON or SSE replies) in place of the TS SDK.
- **Claude**: `fetch` from Rust with SSE parsing for streaming.
- **pdf.js**: `assets/js/pdf.mjs` (esbuild bundle of `pdfjs-dist` with its
  worker and wasm decoders), bound with `#[wasm_bindgen(module = ...)]`; canvas
  rendering and the text layer stay pdf.js's, and everything around them (the
  virtualised page list, zoom, annotations, define, find) is Rust.
- **Vault**: WebCrypto through `web-sys` (RSA-OAEP, PBKDF2, AES-GCM), so
  existing locked dumps still open.
- **Toolchain**: stable Rust 1.95 (installed), `wasm32-unknown-unknown`,
  `wasm-bindgen-cli` matching the crate version (oxichrome installs both on
  first build), `wasm-opt` optional.

## Phases (each ends green and committed)
0. **Fork and skeleton**: vendor oxichrome, add pages/newtab/action/CSP/assets
   to it; the extension crate builds a blank new tab; e2e harness can load
   either build (`DIST=`).
1. **Core**: port the pure modules with their unit tests (`cargo test`),
   ported test for test from the 664 TS tests that cover kept code.
2. **Background**: router, reading session + DNR, PDF rules, alphaXiv sign-in,
   MCP and sync, alarms, migrations on install.
3. **Simple pages**: blocked, options (with alphaXiv), dumps, new tab.
4. **Reader**: pdf.js bridge, viewport, annotations, outline, find, define.
5. **Switch**: full browser suite + screenshot baselines pass on the Rust
   build; delete the TS tree; `npm` scripts call `cargo oxichrome`.
6. **Papers-library steps 4–6 in Rust**: walnut page recolour, questions,
   explain-back, alphaXiv highlights, the shelf, the new tab.

## Testing
- `cargo test` for `core` (natively, fast) from phase 1.
- `wasm-bindgen-test` in headless Chrome for the extern-bound code.
- The Playwright suite (TS, unchanged) is the port's acceptance test: it
  drives whichever `dist/` it is pointed at; screenshot baselines must match.
- `cargo clippy -D warnings` and `cargo fmt --check` gate every commit.

## Decided (by the user)
Full port; extend oxichrome; Claude writes all of it; steps 4–6 built in Rust.

## Left to the builder (Claude's calls, flagged here)
- Vendored fork in-repo rather than a GitHub fork (no outward action).
- `core` split from `ext` so most code tests natively.
- pdf.js and KaTeX stay JS; the brain MCP server stays Node.
- Storage and message shapes stay byte-compatible (no migration at switch).
