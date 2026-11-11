# Vendored oxichrome

Upstream: https://github.com/0xsouravm/oxichrome at `718c56d0d08763600c704ef18ae0cb060e7d8e83` (v0.2.1), MIT
(see LICENSE). Vendored on 2026-11-02 so this extension can extend it.
The examples and CI are left out.

Every local change is its own commit touching only vendor/oxichrome, written
to be upstreamable. `git log -- vendor/oxichrome` lists them.

`Cargo.lock` is committed (upstream ignores it), so the CLI that every
`npm run build:ext` builds, and CI's tests of the fork, resolve the same
dependencies on every clone; both run with `--locked`.

This extension uses `#[oxichrome::extension]`, `#[oxichrome::page]` and the
CLI's build. The rest (oxichrome-core's storage/tabs/runtime wrappers, the
popup, options-page and content-script codegen) is upstream's and kept as is,
so the fork stays a small diff against it. The CLI writes `background.js` only
when the final manifest loads it; ours points the worker at `worker.js`.
