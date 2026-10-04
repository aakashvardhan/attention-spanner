import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Every rule that moves on a spring token is stilled under Reduce Motion: its
 * selector is listed again inside the same stylesheet's
 * `@media (prefers-reduced-motion: reduce)` block. Static, like the design
 * system lint: it reads source, so it never flakes. A rule meant to move
 * regardless says so with a `motion-exempt: <reason>` comment in its body,
 * which excuses that rule only, not its selector elsewhere.
 */

const ROOT = join(__dirname, '..', '..');
const REDUCE = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;

const selectorsOf = (text: string) => text.split(',').map((s) => s.replace(/\s+/g, ' ').trim());

/** Selectors of rules that use a spring token but are not stilled under Reduce Motion. */
export function unstilled(source: string): string[] {
  const EXEMPT = '__motion_exempt__';
  let css = source.replace(/\/\*[^*]*motion-exempt:[\s\S]*?\*\//g, EXEMPT).replace(/\/\*[\s\S]*?\*\//g, '');
  const stilled = new Set<string>();
  for (let m = REDUCE.exec(css); m; m = REDUCE.exec(css)) {
    // Cut the block out by matching braces, keeping the selectors inside it.
    let depth = 1;
    let i = m.index + m[0].length;
    while (depth > 0 && i < css.length) ((depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0), i++);
    const block = css.slice(m.index + m[0].length, i - 1);
    for (const rule of block.matchAll(/([^{}]+)\{[^{}]*\}/g)) selectorsOf(rule[1]).forEach((s) => stilled.add(s));
    css = css.slice(0, m.index) + css.slice(i);
    REDUCE.lastIndex = m.index;
  }
  const out: string[] = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (rule[2].includes('var(--spring-') && !rule[2].includes(EXEMPT))
      out.push(...selectorsOf(rule[1]).filter((s) => !stilled.has(s)));
  }
  return out;
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith('.css') ? [relative(ROOT, path)] : [];
  });
}

describe('unstilled', () => {
  const springy = '.a, .b { transition: transform var(--dur-snappy) var(--spring-snappy); }';

  it('flags a spring rule with no reduced-motion counterpart', () => {
    expect(unstilled(springy)).toEqual(['.a', '.b']);
  });

  it('accepts a rule stilled under reduced motion, selector by selector', () => {
    expect(
      unstilled(`${springy}\n@media (prefers-reduced-motion: reduce) {\n  .a,\n  .b { transition: none; }\n}`),
    ).toEqual([]);
    expect(unstilled(`${springy}\n@media (prefers-reduced-motion: reduce) { .a { transition: none; } }`)).toEqual([
      '.b',
    ]);
  });

  it('skips a rule that carries a motion-exempt reason, and only that rule', () => {
    expect(
      unstilled('.a { animation: x 1s var(--spring-smooth); /* motion-exempt: owner wants it always on */ }'),
    ).toEqual([]);
    expect(
      unstilled(
        `/* a note */\n.a { animation: x 1s var(--spring-smooth); /* motion-exempt: always on */ }\n${springy}`,
      ),
    ).toEqual(['.a', '.b']);
  });

  it('ignores rules that do not use a spring, and comments', () => {
    expect(unstilled('.a { transition: color 0.2s var(--ease-out); } /* var(--spring-x) */')).toEqual([]);
  });
});

describe('every stylesheet', () => {
  it.each(cssFiles(join(ROOT, 'src')))('%s stills its springs under reduced motion', (file) => {
    expect(unstilled(readFileSync(join(ROOT, file), 'utf8'))).toEqual([]);
  });
});

describe('the masthead hover wave', () => {
  const css = readFileSync(join(ROOT, 'src/pages/newtab/newtab.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const at = css.indexOf('.edition-name:hover .edition-name-line > span');
  const rule = css.slice(at, css.indexOf('}', at));

  // The display serif draws as static faces in Chrome, so a weight change
  // snaps to a wider face and the centred name slides under the cursor.
  it('moves the letters without changing their weight', () => {
    expect(at).toBeGreaterThan(-1);
    expect(rule).not.toMatch(/font-weight/);
  });

  it('only applies when motion is allowed', () => {
    const before = css.slice(0, at);
    const opened = before.lastIndexOf('@media (prefers-reduced-motion: no-preference)');
    expect(opened).toBeGreaterThan(-1);
    // Still open: more braces opened than closed since the media query began.
    const span = before.slice(opened);
    expect(span.split('{').length - span.split('}').length).toBeGreaterThan(0);
  });
});
