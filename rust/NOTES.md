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
