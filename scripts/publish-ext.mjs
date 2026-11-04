// Swap a finished build (rust/ext/.build) into rust/ext/dist/chromium, the
// folder Chrome loads. Building in place took ~35s during which a Chrome
// reloading the extension paired one build's JS glue with another's wasm
// (LinkError: "function import requires a callable"). Copy next to the live
// folder, then two renames: Chrome only ever sees a complete build. Same
// path as before, so the extension id (and its storage) stays put.
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';

const src = 'rust/ext/.build/chromium';
const live = 'rust/ext/dist/chromium';
const next = `${live}.next`;
const old = `${live}.old`;
rmSync(next, { recursive: true, force: true });
rmSync(old, { recursive: true, force: true });
cpSync(src, next, { recursive: true });
if (existsSync(live)) renameSync(live, old);
renameSync(next, live);
rmSync(old, { recursive: true, force: true });
console.log(`[publish] ${src} -> ${live}`);
