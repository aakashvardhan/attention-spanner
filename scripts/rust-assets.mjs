// Copies the shared static assets into the Rust crate's static/ dir, which
// oxichrome copies into dist. public/ (fonts, icons) as is; the stylesheets
// from rust/ext/css into assets/.
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

const out = 'rust/ext/static';
rmSync(out, { recursive: true, force: true });
// oxichrome adds to dist without clearing it; start clean so stale files never ship.
rmSync('rust/ext/dist', { recursive: true, force: true });
mkdirSync(join(out, 'assets'), { recursive: true });
cpSync('public', out, { recursive: true });
for (const css of readdirSync('rust/ext/css').filter((f) => f.endsWith('.css')))
  cpSync(join('rust/ext/css', css), join(out, 'assets', css));
// Hand-written JS the crate ships as is (the worker's synchronous listeners).
cpSync('rust/ext/js/worker.js', join(out, 'worker.js'));
// pdf.js, unmodified: the library, its worker, and the wasm decoders for scanned pages.
mkdirSync(join(out, 'pdfjs'), { recursive: true });
for (const f of ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'wasm/jbig2.wasm', 'wasm/openjpeg.wasm', 'wasm/qcms_bg.wasm'])
  cpSync(join('node_modules/pdfjs-dist', f), join(out, 'pdfjs', basename(f)));
// KaTeX, unmodified: the module (loaded on first maths), its stylesheet, and the fonts it names relatively.
mkdirSync(join(out, 'katex'), { recursive: true });
cpSync('node_modules/katex/dist/katex.mjs', join(out, 'katex', 'katex.mjs'));
cpSync('node_modules/katex/dist/katex.min.css', join(out, 'assets', 'katex.min.css'));
// woff2 only (Chrome takes the first source); skip Finder's "name 2.ext" duplicates.
cpSync('node_modules/katex/dist/fonts', join(out, 'assets', 'fonts'), {
  recursive: true,
  filter: (src) => !/ 2\./.test(src) && !/\.(ttf|woff)$/.test(src),
});
