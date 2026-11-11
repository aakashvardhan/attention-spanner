// Swap a finished build (rust/ext/.build) into rust/ext/dist/chromium, the
// folder Chrome loads. Building in place took ~35s during which a Chrome
// reloading the extension paired one build's JS glue with another's wasm
// (LinkError: "function import requires a callable"). Move it next to the
// live folder, then two renames: Chrome only ever sees a complete build. Same
// path as before, so the extension id (and its storage) stays put. Renames,
// not copies: .build is on the same disk, so there is never a second full
// build left lying around.
//
// The swap alone is not enough: a running extension can keep an older build's
// glue in its script cache and fetch the new wasm, the same LinkError. So the
// wasm is named by its content hash and the glue rewritten to that name; a stale
// glue then asks for a file that no longer exists instead of mislinking.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const src = 'rust/ext/.build/chromium';
const live = 'rust/ext/dist/chromium';
const next = `${live}.next`;
const old = `${live}.old`;
rmSync(next, { recursive: true, force: true });
rmSync(old, { recursive: true, force: true });
mkdirSync('rust/ext/dist', { recursive: true });
renameSync(src, next);
rmSync('rust/ext/.build', { recursive: true, force: true });

const wasm = `${next}/wasm/reader_ext_bg.wasm`;
const glue = `${next}/wasm/reader_ext.js`;
const hashed = `reader_ext_bg.${createHash('sha256').update(readFileSync(wasm)).digest('hex').slice(0, 12)}.wasm`;
const ref = "new URL('reader_ext_bg.wasm', import.meta.url)";
const code = readFileSync(glue, 'utf8');
if (code.split(ref).length !== 2) throw new Error(`[publish] expected one ${ref} in ${glue}; wasm-bindgen changed its loader`);
writeFileSync(glue, code.replace(ref, `new URL('${hashed}', import.meta.url)`));
renameSync(wasm, `${next}/wasm/${hashed}`);
if (existsSync(live)) renameSync(live, old);
renameSync(next, live);
rmSync(old, { recursive: true, force: true });
console.log(`[publish] ${src} -> ${live}`);
