// Copies the shared static assets into the Rust crate's static/ dir, which
// oxichrome copies into dist. public/ (fonts, icons) as is; every stylesheet
// under src/ flat into assets/. One source of truth until the TS tree goes.
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const out = 'rust/ext/static';
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'assets'), { recursive: true });
cpSync('public', out, { recursive: true });
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.css') ? [p] : [];
  });
for (const css of walk('src')) cpSync(css, join(out, 'assets', basename(css)));
