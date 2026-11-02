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
