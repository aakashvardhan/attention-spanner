# Learning notes: the Rust/WebAssembly port

One entry per phase: the Rust and wasm ideas the phase used, and where to read
them. Read the files in the order listed.

## Phase 0: fork and skeleton

**Build it:** `npm run build:rust`, then load `rust/ext/dist/chromium` unpacked.
**Test it:** `npm run test:rust` (cargo test, clippy, fmt) and
`DIST=rust/ext/dist/chromium npx vitest run --config vitest.e2e.config.ts e2e/port.e2e.ts`.

1. **Workspaces and crates** (`rust/Cargo.toml`, `rust/*/Cargo.toml`). A
   workspace builds several crates with one lockfile and one `target/`.
   `core` is a plain library; `ext` is `crate-type = ["cdylib", "rlib"]`:
   `cdylib` is what becomes the `.wasm` file, `rlib` lets native tests and
   tools link it too. `[workspace.lints] unsafe_code = "forbid"`: nothing here
   needs `unsafe`, so the compiler refuses it.
2. **Attribute proc macros** (`vendor/oxichrome/oxichrome-macros/src/codegen/page.rs`).
   `#[oxichrome::page(...)]` is a function the compiler runs on your code at
   build time: it receives the tokens of `fn NewTab`, parses them with `syn`,
   and returns new tokens with `quote!`, here the component plus an exported
   `__oxichrome_mount_page_newtab`. Errors are `syn::Error`s pointing at the
   exact argument, so a bad `path` fails the compile with a red squiggle.
3. **`#[wasm_bindgen]` exports** (same file). Marking a `pub fn` with it makes
   it callable from JavaScript; `wasm-bindgen` (the CLI) generates
   `wasm/reader_ext.js`, the glue that loads the `.wasm` and exposes those
   functions. Look at `dist/chromium/src/pages/newtab/index.js`: it imports
   `init` and the mount function, and that is the whole page boot.
4. **Two passes over the same source** (`oxichrome-build/src/source_parser.rs`).
   The build does not compile your crate to find pages; it parses `lib.rs`
   with `syn` and walks the syntax tree with a `Visit` impl, reading each
   attribute's arguments. Pattern matching (`match value { Expr::Lit(..) if
   path.is_ident("path") => … }`) with guards is how Rust takes apart a tree.
5. **Leptos views** (`rust/ext/src/lib.rs`). `view! { <main class="edition">… }`
   is JSX-like syntax expanded by a macro into DOM-building code. Text is a
   Rust string literal in quotes; `{expr}` interpolates. `impl IntoView` means
   "some type that can render", chosen by the compiler, not you.
6. **`serde_json::Value` and recursion** (`oxichrome-build/src/manifest.rs`,
   `apply_patch`). Matching on a tuple of two enum references
   `(Value::Object(b), Value::Object(p))` and recursing is the deep merge;
   `entry(k).or_insert(Null)` borrows a slot mutably so the recursion writes in
   place. The borrow checker is why this needs no clones of the base.

## Phase 1a: the first pure modules (`rust/core/src`)

Ported test for test from the TypeScript (`cargo test -p reader-core`: 55 ported + 1).

1. **serde as the storage contract** (`types.rs`). `#[serde(rename_all = "camelCase")]`
   makes `folder_ids` read and write `folderIds`; `skip_serializing_if =
   "Option::is_none"` drops `None` instead of writing `null`, the way TS drops
   `undefined`. `#[serde(tag = "kind")]` on an enum is TypeScript's
   discriminated union. `type` is a Rust keyword, so `Folder.kind` carries
   `#[serde(rename = "type")]`. The round-trip test pins byte compatibility.
2. **`Option` instead of `null`** (`papers.rs`, `pdf.rs`). `parse_paper_ref`
   returns `Option<String>`, and `?` inside a function returning `Option`
   means "return `None` if this is `None`": the early returns of the TS
   collapse into one character. `.then(|| …)` / `.then_some(…)` turn a `bool`
   into an `Option`.
3. **Statics compiled once** (`static ARXIV_URL: LazyLock<Regex>`). Rust has no
   regex literal; `LazyLock` builds the value on first use and shares it
   across threads safely.
4. **Borrowing slices instead of copying** (`strip_prefix_ignore_case<'a>`).
   The `'a` lifetime says the returned `&str` points into the input; no new
   string is allocated. `s.get(..n)` returns `None` instead of panicking when
   `n` is past the end or not on a character boundary.
5. **Strings are UTF-8, not UTF-16** (`clicked_word.rs`). JavaScript indexes
   strings in UTF-16 units; Rust `&str` indexes bytes and only on char
   boundaries. The port collects `Vec<char>` so offsets count characters.
6. **Iterator chains** (`focus_rules.rs`, `reading_aids.rs`). `enumerate().map().collect()`
   builds the DNR rules; `position(…)`, `take_while(…).count()` and `sum()`
   replace index loops. They compile to the same loops, without bounds bugs.
7. **Generics and closures** (`outline.rs`). `flatten_outline<D>` works for any
   destination type; `impl Fn(&D) -> Option<u32>` takes the lookup closure.
   The inner recursive `fn walk` can't capture variables, so the closure is
   passed in as `&dyn Fn`: a trait object, Rust's dynamic dispatch.

## Phase 1b (part 1): alphaXiv rules, activity, annotations, AI, reader progress

115 core tests. Ideas to read for:
1. **Errors as values** (`alphaxiv.rs`): `Result<T, AlphaxivError>` plus `impl
   Display` and `std::error::Error`; `map_err` / `ok_or_else` turn one failure
   into another without exceptions.
2. **No clock, no time zone in pure code** (`civil_date.rs`): dates are plain
   values; the browser passes "today" and a timestamp→date closure in.
3. **Struct update syntax** (`Paper { title, ..paper.clone() }`) builds a
   changed copy, like `{ ...paper, title }`.
4. **`include_str!`** embeds the recorded alphaXiv fixtures at compile time.
5. **Floats have no total order**: `sort_by` with `partial_cmp` in `annotations.rs`.

## Phase 1b (part 2): migrations and the worker's rules. Phase 1 done: 131 core tests.

1. **Effects at the edge** (`migrations.rs`). `migrate` takes a snapshot of
   storage (`serde_json::Map`) and returns a `Plan`; it never touches Chrome.
   The worker in phase 2 does `remove(plan.remove)` then `set(plan.set)`. So
   the whole migration, including a full legacy profile and an idempotent
   re-run, is tested natively with no fakes.
2. **Working on untyped JSON on purpose**. Old records have shapes no current
   struct describes; `Value`, `as_array`, `get(..).and_then(Value::as_str)`
   read them defensively, and only the result is typed (`Vec<Paper>`).
3. **Injecting what pure code cannot make** (`new_id: impl FnMut() -> String`).
   UUIDs need randomness; the caller passes a closure (the browser's
   `crypto.randomUUID`, or a fixed value in tests). `FnMut` because it may
   change state each call.
4. **Ranges as sets** (`(FOCUS_DNR_ID_BASE..FOCUS_DNR_ID_LIMIT).contains(&id)`)
   read as the half-open interval they are.

## Phase 2: the background worker (`rust/ext/src/worker`, `rust/ext/js/worker.js`)

`npm run test:e2e:rust`: 11 browser tests drive the Rust worker for real.

1. **Why a hand-written `worker.js`.** MV3 only delivers the event that woke
   the worker to listeners registered in its first turn; `init()` (loading
   wasm) is async, so Rust can't register them in time. The JS registers all
   of them synchronously and forwards each to an exported `async fn`. An
   `async fn` with `#[wasm_bindgen]` becomes a JS function returning a Promise.
2. **Binding JS from Rust** (`chrome.rs`). `extern "C"` blocks declare JS
   functions; `js_namespace = ["chrome", "tabs"]` names where they live;
   `catch` makes a synchronous JS throw an `Err`. `JsFuture::from(promise).await`
   (in `js::wait`) turns a JS Promise into a Rust future.
3. **serde across the boundary** (`js.rs`). `serde_wasm_bindgen` converts Rust
   values to JS ones; `Serializer::json_compatible()` is essential, because
   the default turns maps into JS `Map`s, which `chrome.storage` silently stores as `{}`.
4. **Single-threaded shared state** (`alphaxiv.rs`, `thread_local!` +
   `RefCell`). wasm has one thread, so "thread local" is "global to the worker".
   `RefCell` checks borrows at runtime instead of compile time. The in-flight
   token refresh is stored as a JS `Promise` (`future_to_promise`) so a second
   caller awaits the same one: alphaXiv's refresh tokens are single-use.
5. **A protocol client from scratch** (`reader_core::mcp` + `worker/alphaxiv.rs`).
   MCP is JSON-RPC over HTTP: `initialize`, keep the `mcp-session-id` header,
   `notifications/initialized`, then `tools/call`; replies come as JSON or as a
   server-sent event stream. The parsing is pure and tested natively; the
   e2e test runs the real thing against a mock server, 401 and refresh included.
6. **Recursion in async code** (`Box::pin(call_once(..)).await`). An `async fn`
   that calls itself would have an infinitely sized future; boxing it gives
   the recursive call a fixed-size pointer.

## Phase 3: the pages in Leptos (`rust/ext/src/pages`)

The blocked page, Settings, the new tab and the dumps page match the
TypeScript screenshot baselines; 35 browser tests run on the Rust build.

1. **Signals** (`pages/mod.rs`, `use_storage`). `signal(T)` gives a read and a
   write half; reading one inside `move || …` in `view!` subscribes that spot
   of the DOM, so only it re-renders. `use_storage` fills a signal from
   `chrome.storage` and keeps it in step through `onChanged`: the Leptos
   version of the React hook, without a re-render of the whole component.
2. **`Memo` and `Signal::derive`**: values computed from other signals, cached
   (`Memo`) or recomputed (`derive`). The heatmap model is a `Memo`.
3. **Branches in views** return different types, so each arm ends in
   `.into_any()`; `Option<View>` renders nothing for `None`.
4. **`Callback`, `StoredValue`, `NodeRef`**: a callback a child can call; a
   non-reactive value a closure can share; a handle on a real DOM element
   (focus, selection, measuring).
5. **Byte-compatible cryptography** (`vault.rs`). WebCrypto is called through
   our own externs on `crypto.subtle`; algorithm objects are built from JSON
   plus `Reflect::set` for the typed-array fields. The e2e test proves both
   directions with the TypeScript implementation itself.
6. **Streaming a response body** (`claude.rs`). `res.body().get_reader()`,
   `read()` in a loop, a `TextDecoder` in stream mode (a UTF-8 character can
   straddle two chunks), and `SseBuffer` (core) cutting events at any byte.
7. **Borrows in a tail expression** (`with_dump_lock`): the compiler error
   E0597 there is because a temporary in the last expression lives until the
   end of the block, after `out` is gone. Binding it to a variable first fixes it.

## Phase 4a: the reader (`rust/ext/src/pages/reader`, `rust/ext/js/pdf-bridge.mjs`)

pdf.js stays JavaScript behind a bridge of plain functions; Rust decides
everything about what comes back. 43 browser tests on the Rust build,
including pinch-zoom geometry and scanned pages.

1. **Binding a JS module** (`pdfjs.rs`, `#[wasm_bindgen(module = "/js/pdf-bridge.mjs")]`).
   wasm-bindgen copies the file into the build as a snippet and imports it.
   The pdf.js document is an opaque `JsValue` Rust holds but never opens.
2. **Values that are not `Send`.** Leptos signals normally require
   `Send + Sync`; a `JsValue` is neither. `StoredValue::new_local` and
   `RwSignal::new_local` are the single-threaded variants, fine in wasm.
3. **Observers from Rust** (`viewport.rs`). `ResizeObserver` and
   `IntersectionObserver` take a JS callback: a `Closure` built in Rust,
   `.forget()`-ed because the observer owns it for the page's life. The bug
   to read: observers that queried for pages once missed pages that mounted
   later; each page now registers itself when it mounts.
4. **Effect ordering** (the pinch fix). A user `Effect` can run before the
   reactive `style:` update of the same change lands, so the browser saw the
   old list width and clamped `scrollLeft`. The instrumented log showed
   it; the effect now writes the new size itself before scrolling.
5. **Non-passive listeners.** Stopping the browser's own zoom needs
   `addEventListener('wheel', f, { passive: false })`, built with
   `AddEventListenerOptions` rather than Leptos's `on:wheel`.
6. **Copy closures.** A closure that captures a `String` can be called once
   if it moves it. Holding the string in a `StoredValue` (itself `Copy`)
   makes the closure `Copy`, so it can be shared by several handlers.

## Phase 4b: working on the page (`reader/annotate.rs`, `reader/define.rs`, `pages/ai.rs`, `core/src/markdown.rs`)

Highlights, sticky notes, the notes list, and click-to-define with Markdown
and maths. 47 browser tests on the Rust build, stable over three runs; the
three new ones (KaTeX in a definition, the highlight/sticky/notes flow) pass
on the TypeScript build too, so they test behaviour, not the port.

1. **A parser as an event stream** (`markdown.rs`). `pulldown-cmark` yields
   `Event`s (`Start(Tag::Link)`, `Text`, `End`…) and `html::push_html` writes
   them. Sanitising is a `filter_map` over that stream: raw HTML events are
   dropped, a link with a `javascript:` target loses its tags but keeps its
   text, a safe one is replaced by our own `<a … rel="noopener">`. Two small
   stacks remember whether each open link/image was kept, so its end tag matches.
2. **Hand-written scanning instead of a regex.** The TS maths regex used a
   back-reference (`\end{\1}`) and a look-behind; the `regex` crate supports
   neither (by design: it guarantees linear time). Each delimiter is a small
   function returning `Option<(consumed, content)>`, tried in order with
   `.or_else`. Same results, and each rule is readable on its own.
3. **Placeholders that survive the parser.** NUL (the TS choice) is replaced
   by U+FFFD under CommonMark; private-use characters (U+E000) pass through.
4. **Lazy JS from wasm** (`js/katex-bridge.mjs`). Every page shares one wasm
   module and therefore every snippet it imports, so a static `import katex`
   would load 600 KB on each new tab. The bridge `import()`s KaTeX on the
   first formula; `renderTex` returns `Option<String>` (JS `null` → `None`).
5. **`Send` again, from the other side** (`NotePopover`). `on_cleanup`
   requires `Send + Sync`, so the unmount commit cannot hold an
   `Rc<RefCell<…>>`; it holds `Arc<Mutex<…>>` (uncontended in wasm, so free).
   Plain shared cells rather than signals, because by unmount time the
   popover's signals may be gone.
6. **Superseding async work** (`Ai::start`). A generation counter in a
   `StoredValue`: every await is followed by "am I still the latest?", and
   `try_get_value()` returns `None` once the component is gone, so an answer
   arriving after the popover closed is dropped instead of panicking. Stop is
   an `AbortController` passed into the shared Claude stream.
7. **Two kinds of offsets.** The DOM counts UTF-16 units, Rust strings bytes,
   `clicked_word` chars. `utf16_to_chars` / `chars_to_utf16` (core, tested
   with a 2-unit maths italic letter) convert at the boundary.
8. **Events that do not reach `window`.** `selectionchange` fires on the
   document only, so `window_event_listener` cannot hear it; that one listener
   is added by hand with a `Closure` and removed in `on_cleanup`.

Found, not fixed (the port keeps behaviour; for phase 6):
- The notes list's delete mark shows on hover only and is a `span`, so it
  cannot be reached from the keyboard (WCAG 2.1.1).
- The side panels are translucent; over a white PDF page their cream text is
  low contrast. The walnut page recolour should fix it; the AAA tests should check.
- pdf-bridge imports pdf.js statically, so every page (and the worker)
  loads it. Phase 5 should make it lazy, as KaTeX now is.

## Phase 5: the switch (`rust/ext/src/pages/papers.rs`, `package.json`, `rust/Cargo.toml`)

The Rust build is now the extension. The TypeScript tree (`src/`, Vite,
React) is gone; what stays TypeScript is the Playwright suite, the brain MCP
server (`mcp/brain`, its library moved from `src/shared/brain` to
`mcp/brain/lib`), and the stylesheet guards, which moved with the CSS to
`rust/ext/css`. 53 browser tests and the screenshot baselines pass on the
release build.

1. **Debug vs release wasm.** oxichrome builds debug unless told `--release`:
   54 MB. Release is 10.5 MB, and 6 MB of that was the `name` custom section
   (every function's name, for stack traces). `strip = "symbols"` drops it;
   `lto = true` and `codegen-units = 1` let the optimiser see the whole
   program at once. 3.9 MB. `opt-level = "s"` made it *bigger* here (14 MB,
   the names section grew), a reminder to measure rather than assume.
   Reading a wasm file's sections is a 15-line LEB128 walk (id byte, size,
   payload); that is how the 6 MB showed up.
2. **Lazy JS, again.** pdf.js joined KaTeX behind a dynamic `import()` in its
   bridge. Every bridge function except `openPdf` takes a document, so only
   `openPdf` has to await the load; the rest find it already there. The
   service worker imports the bridge too but never calls `openPdf`, which
   matters: `import()` is not allowed in a service worker. A new-tab test
   checks neither library is requested.
3. **Proof that outlives the code it proves against.** The vault test used to
   import the TypeScript vault to make a locked dump. Before deleting it, a
   one-off script made one (`e2e/fixtures/ts-vault.json`); the test now opens
   that, so profiles with TypeScript-sealed dumps stay covered.
4. **Guards follow the code.** The cut-features test scans `rust/` now, `.rs`
   included; it caught a test of mine using a retired model name as a sample.

Seen while switching, not fixed: one run in six had a Chromium "Target
crashed" (no extension error before it), and one had a new-tab screenshot
mismatch that did not recur in five runs.

## Phase 6a: the reader asks (`core/src/{recolor,questions,explain}.rs`, `reader/think.rs`)

Papers-library step 4, built in Rust. The page is walnut, the reader asks one
question at a section's end (or on Q, or after two minutes on one view), and
E opens the explain-back: problem, trick, why, graded to the gap and the page
to look at. 56 browser tests pass, 4 of them new.

1. **Pixels across the boundary.** pdf.js paints off-screen; the bridge hands
   the pixels (`Uint8ClampedArray`) to a Rust closure, which copies them into a
   `Vec<u8>`, recolours, and copies back (`copy_from`). Two copies of a few MB
   per page is cheap next to the render. The closure is made once
   (`thread_local!` + `into_js_value`, which leaks it on purpose: it lives as
   long as the page) and passed as an ordinary JS function.
2. **What counts as a figure.** An embedded image paints the unit square under
   the current transform, so following `save`/`restore`/`transform` (and form
   XObjects, which push their own matrix) through `getOperatorList()` gives
   each image's box. Inside a box nothing changes; outside, greys map onto
   paper-to-ink and anything coloured (plot lines) is left alone. Vector
   figures drawn in black become cream, which reads fine. The rule is pure
   (`recolor.rs`), so it is tested natively on a 2x2 pixel image.
3. **`as_chunks`.** Clippy now prefers `as_chunks_mut::<4>()` to
   `chunks_exact_mut(4)`: the chunk is a `&mut [u8; 4]`, a fixed-size array,
   so `px[3]` is checked at compile time rather than at run time.
4. **The rule lives in the parser.** "Never show the answer" is enforced by
   `parse_grades`: the model's JSON is read into `Grade { part, status, gap,
   page }`, and serde drops every other field. A stray `"answer"` cannot reach
   the page because there is nowhere to put it. The panel shows the raw reply
   only when it is an error.
5. **Effects remember.** `Effect::new(move |before| …)` gets its own previous
   return value, which is how "the reader moved from section 2 into section 3"
   is detected without another signal. Only a step to the *next* section
   counts: a jump from the outline did not read what it skipped.
6. **Grounding.** Questions and grades read the paper text the reader already
   has (pdf.js's page texts, marked `[page N]`), not alphaXiv's retrieval: the
   same pages, exact page numbers, no sign-in needed.

Fixed on the way: the notes list's delete is a real button beside the row
(it was a `span` inside a `button`), faded rather than hidden so Tab reaches
it; the section rail's buttons had no accessible name while their labels were
hidden (an outlined test PDF found it). The translucent-panel contrast issue
went away with the walnut page.

Open: alphaXiv highlights (one-way import) wait on a real `get_paper_notes`
reply to read the format from. The stall time is a constant, not a setting,
and the stall itself has no browser test (two minutes of waiting).

## Phase 6b: the bookshelf (`core/src/shelf.rs`, `pages/papers.rs`)

Papers-library step 5. One shelf per alphaXiv folder; a spine carries a short
code ("Mamba '23"), its width is the page count, and a brass band at its foot
grows with progress. Arrows walk the books, Enter pulls one out (where you
stopped, the gaps still open from the last explain-back, Continue), M or a
drag moves it to another folder, and the New-arrivals cart (alphaXiv's Hot and
For You) shelves a paper with S. 60 browser tests pass, 4 of them new.

1. **One tab stop for a whole bookcase.** A roving tabindex: exactly one book
   has `tabindex="0"`, the rest `-1`, and the arrow keys move both the focus
   and that 0. `step(lens, at, key)` is the pure rule (skip empty shelves, keep
   the column), tested natively; the page only calls `focus()` on the result.
2. **Optimistic, with the rollback in one place.** The worker moves the book
   on the local shelf first (the page redraws from storage at once), then asks
   alphaXiv. If alphaXiv refuses, it reads the shelf *again* and restores only
   that book's folders, so progress the reader saved meanwhile survives.
   `move_paper` returns what to restore, which is all the rollback needs.
3. **Boxing a big variant.** Clippy's `large_enum_variant`: an enum is as big
   as its largest variant, so `Shelving::Move { paper: Paper }` made every
   `Shelving` the size of a `Paper`. `Box<Paper>` puts the paper on the heap
   and the enum shrinks to a pointer plus the small variant.
4. **Drag carries text.** HTML5 drag-and-drop moves strings, not values: the
   book writes `"{paper id}\n{folder id}"` under its own type
   (`application/x-paper`), and a shelf's `drop` reads it back. Every other
   drag (a link, a file) has no such entry and is ignored.
5. **Titles from arXiv.** alphaXiv's feeds return ids only. The arXiv export
   API answers with Atom XML; three small regexes read `<entry>`, `<id>` and
   `<title>` (no XML crate for a format this regular). An id arXiv does not
   know keeps its id as its title: shelving still works.

Choices: the title plate is one nameplate under each shelf rather than a
plate floating over the book, so a book at the right edge cannot push the page
sideways. The pull-out card and move menu are non-modal panels that hand focus
back to the book on Esc.

Open: no drag between shelves by keyboard other than M (by design: M is the
keyboard path). The cart is fetched once per page open, not cached.
