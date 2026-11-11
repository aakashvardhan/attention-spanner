import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Every stylesheet stays on the design system in theme.css: colors through
 * tokens, spacing on the 4px grid, type and radii from their scales, every
 * size with its leading, durations from the motion tokens. Static on purpose:
 * it reads source, so it is fast and never flaky. A justified exception
 * carries `ds-exempt: <reason>` in a comment on the same line.
 */

interface Violation {
  file: string;
  line: number;
  rule: 'color' | 'spacing' | 'font-size' | 'line-height' | 'leading' | 'font-weight' | 'radius' | 'gradient' | 'shadow' | 'duration';
  value: string;
}

const ROOT = __dirname;
const THEME = 'theme.css';
/* The exemptions in use today: the pdf.js text layer's size, the focus line's
   mask, and the three clock hands that turn in real time. Raise it only for a
   reason the lint cannot express. */
const MAX_EXEMPTIONS = 5;

/* A derived colour (color-mix) is still a colour: it belongs in theme.css. */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bcolor-mix\(/;
const NAMED_COLOR = /\b(white|black|red|green|blue|orange|gray|grey|yellow|purple|pink)\b/;
const COLOR_PROPS = /^(color|background(-color)?|border(-[a-z]+)*|outline(-color)?|fill|stroke|box-shadow|text-decoration-color|caret-color|accent-color)$/;
const SPACING_PROPS = /^((margin|padding|inset)(-[a-z-]+)?|gap|row-gap|column-gap|top|right|bottom|left|grid-template-(columns|rows))$/;
const PX = /(-?\d*\.?\d+)px/g;
const GRADIENT = /\b(repeating-)?(linear|radial|conic)-gradient\(/;
const MOTION_PROPS = /^(transition|animation)(-duration|-delay)?$/;
/* A time literal. `* 1s` / `* -1s` only gives a unitless number its unit
   (the clock hands' delays), so it is not a duration of its own. */
const TIME = /(?<![\w.-])-?\d*\.?\d+m?s\b/;
const UNIT_SCALE = /\*\s*-?1m?s\b/g;
/* One elevation and the focus ring, nothing else. theme.css defines the
   elevation as --shadow-lg (things that float over the page: menus, popovers,
   the pulled-out book card) and draws its focus ring in --accent. A ring is spread only,
   no blur, so it reads as an outline rather than a shadow. */
const ELEVATION = ['--shadow-lg'];
const FOCUS_RING = ['--accent'];
const ALLOWED_SHADOW = new RegExp(
  `^(none|var\\((${ELEVATION.join('|')})\\)|0 0 0 \\d+px var\\((${FOCUS_RING.join('|')})\\))$`,
);

/** Blank out comments but keep every newline, so line numbers survive. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

function lintCss(source: string, file: string): Violation[] {
  const exempt = new Set(
    source.split('\n').flatMap((l, i) => (l.includes('ds-exempt:') ? [i + 1] : [])),
  );
  const lines = stripComments(source).split('\n');
  const out: Violation[] = [];
  const isTheme = file === THEME;
  // The property a multi-line value belongs to (`transition:` then one part a line).
  let current = '';
  lines.forEach((text, i) => {
    const line = i + 1;
    const bare = /^\s*(-{0,2}[a-z][a-z0-9-]*)\s*:\s*$/.exec(text);
    if (bare) current = bare[1];
    if (exempt.has(line)) return;
    // Every declaration on the line, so one-line rules (`a { padding: 6px; }`) count too.
    const decls = [...text.matchAll(/(?:^|[{;])\s*(-{0,2}[a-z][a-z0-9-]*)\s*:\s*([^;{}]+)/g)];
    if (decls.length > 0) current = decls[decls.length - 1][1];
    // Continuation lines of a multi-line value (box-shadow stacks) still carry colors.
    if (decls.length === 0) {
      if (!isTheme && !bare && MOTION_PROPS.test(current) && TIME.test(text.replace(UNIT_SCALE, ''))) {
        out.push({ file, line, rule: 'duration', value: text.trim() });
      }
      // `box-shadow:` with the value starting on the next line: no way to vouch for it.
      if (!isTheme && /^\s*box-shadow\s*:\s*$/.test(text)) out.push({ file, line, rule: 'shadow', value: text.trim() });
      if (!isTheme && COLOR_LITERAL.test(text)) out.push({ file, line, rule: 'color', value: text.trim() });
      if (!isTheme && GRADIENT.test(text)) out.push({ file, line, rule: 'gradient', value: text.trim() });
      return;
    }
    for (const [, prop, rawValue] of decls) {
      const value = rawValue.replace(/\s*!important\s*$/, '').trim();
      if (prop.startsWith('--')) {
        if (!isTheme && COLOR_LITERAL.test(value)) out.push({ file, line, rule: 'color', value });
        continue;
      }
      if (!isTheme && (COLOR_LITERAL.test(value) || (COLOR_PROPS.test(prop) && NAMED_COLOR.test(value)))) {
        out.push({ file, line, rule: 'color', value });
      }
      if (!isTheme && GRADIENT.test(value)) out.push({ file, line, rule: 'gradient', value });
      if (!isTheme && prop === 'box-shadow' && !ALLOWED_SHADOW.test(value)) {
        out.push({ file, line, rule: 'shadow', value });
      }
      if (SPACING_PROPS.test(prop) && [...value.matchAll(PX)].some(([, n]) => Number(n) % 4 !== 0)) {
        out.push({ file, line, rule: 'spacing', value });
      }
      if (prop === 'font-size' && !/^(var\(--text-[a-z0-9]+\)|inherit)$/.test(value)) {
        out.push({ file, line, rule: 'font-size', value });
      }
      if (prop === 'line-height' && !/^(var\(--leading-[a-z0-9]+\)|1|inherit)$/.test(value)) {
        out.push({ file, line, rule: 'line-height', value });
      }
      if (prop === 'font-weight' && !/^(400|700|normal|bold|inherit)$/.test(value)) {
        out.push({ file, line, rule: 'font-weight', value });
      }
      if (prop === 'border-radius' && !/^((var\(--radius-[a-z0-9]+\)|50%|0|inherit)\s*)+$/.test(value)) {
        out.push({ file, line, rule: 'radius', value });
      }
      if (!isTheme && MOTION_PROPS.test(prop) && TIME.test(value.replace(UNIT_SCALE, ''))) {
        out.push({ file, line, rule: 'duration', value });
      }
    }
  });
  // A size carries its leading in the same rule: a line-height inherited from
  // a parent of another size is the wrong one (16px type on 20px lines).
  const stripped = stripComments(source);
  for (const m of stripped.matchAll(/[^{}]+\{([^{}]*)\}/g)) {
    const size = /(?:^|[;{\s])font-size\s*:\s*([^;}]+)/.exec(m[1]);
    if (!size || size[1].trim() === 'inherit' || /(?:^|[;\s])line-height\s*:/.test(m[1])) continue;
    const at = m.index + m[0].indexOf('{') + 1 + size.index + size[0].indexOf('font-size');
    const line = stripped.slice(0, at).split('\n').length;
    if (!exempt.has(line)) out.push({ file, line, rule: 'leading', value: size[1].trim() });
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

describe('lintCss', () => {
  const lint = (css: string) => lintCss(css, 'x.css').map((v) => v.rule);

  it('rejects color literals outside theme.css, including multi-line shadows', () => {
    expect(lint('a { color: #fff; }')).toEqual(['color']);
    expect(lint('a {\n  box-shadow: 0 0 0 1px var(--border),\n    0 4px 8px rgba(0,0,0,.2);\n}')).toEqual(['shadow', 'color']);
    expect(lint('a {\n  box-shadow:\n    0 4px 8px var(--border);\n}')).toEqual(['shadow']);
    expect(lint('a { border-color: white; }')).toEqual(['color']);
    expect(lint('a { outline: 1px solid color-mix(in srgb, var(--border) 78%, transparent); }')).toEqual(['color']);
    expect(lintCss('a { color: #fff; }', 'theme.css')).toEqual([]);
  });

  it('accepts tokens, currentColor and transparent', () => {
    expect(lint('a { color: var(--text-primary); background: transparent; fill: currentColor; }')).toEqual([]);
  });

  it('holds spacing to multiples of 4px, including inside calc and grid templates', () => {
    expect(lint('a { padding: 6px 8px; }')).toEqual(['spacing']);
    expect(lint('a { margin: calc(100% - 10px); }')).toEqual(['spacing']);
    expect(lint('a { grid-template-columns: 1fr 70px; }')).toEqual(['spacing']);
    expect(lint('a { padding: var(--space-2) 12px; gap: 0; top: 50%; }')).toEqual([]);
  });

  it('holds type to the scale', () => {
    expect(lint('a { font-size: 13px; line-height: 1; }')).toEqual(['font-size']);
    expect(lint('a { line-height: 1.5; }')).toEqual(['line-height']);
    expect(lint('a { font-weight: 600; }')).toEqual(['font-weight']);
    expect(lint('a { font-size: var(--text-sm); line-height: var(--leading-sm); font-weight: 700; }')).toEqual([]);
  });

  it('pairs every size with a leading in the same rule', () => {
    expect(lint('a { font-size: var(--text-sm); }')).toEqual(['leading']);
    expect(lint('a {\n  font: inherit;\n  font-size: var(--text-xs);\n}')).toEqual(['leading']);
    expect(lintCss('a {\n  color: red;\n  font-size: var(--text-xs);\n}', 'x.css').find((v) => v.rule === 'leading')?.line).toBe(3);
    expect(lint('a { font-size: var(--text-sm); line-height: 1; } b { font-size: inherit; }')).toEqual([]);
    expect(lint('a { font-size: var(--text-sm); } /* ds-exempt: why */')).toEqual([]);
  });

  it('takes durations from the motion tokens', () => {
    expect(lint('a { transition: opacity 300ms var(--ease-out); }')).toEqual(['duration']);
    expect(lint('a { animation: spin 1.2s linear infinite; }')).toEqual(['duration']);
    expect(lint('a {\n  transition:\n    color 0.2s;\n}')).toEqual(['duration']);
    expect(lint('a { animation-duration: .5s; }')).toEqual(['duration']);
    expect(lint('a { transition: color var(--dur-effect-fast) var(--ease-effect); animation: x var(--dur-pulse) steps(2, jump-none) infinite; }')).toEqual([]);
    expect(lint('a { animation-delay: calc(var(--s) * -1s); }')).toEqual([]);
    expect(lintCss('a { transition: color 0.2s; }', 'theme.css')).toEqual([]);
  });

  it('holds radii to tokens', () => {
    expect(lint('a { border-radius: 6px; }')).toEqual(['radius']);
    expect(lint('a { border-radius: var(--radius-lg) var(--radius-lg) 0 0; }')).toEqual([]);
  });

  it('rejects gradients outside theme.css', () => {
    expect(lint('a{background:linear-gradient(red,blue)}')).toContain('gradient');
    expect(lint('a{background:radial-gradient(var(--a),var(--b))}')).toEqual(['gradient']);
    expect(lint('a{background-image:conic-gradient(var(--a),var(--b))}')).toEqual(['gradient']);
    expect(lint('a {\n  background:\n    linear-gradient(var(--a), var(--b));\n}')).toEqual(['gradient']);
    expect(lintCss('a{background:linear-gradient(var(--a),var(--b))}', 'theme.css')).toEqual([]);
  });

  it('allows one elevation token and the focus ring, no other shadow', () => {
    expect(lint('a{box-shadow:0 1px 2px var(--c)}')).toEqual(['shadow']);
    expect(lint('a{box-shadow:var(--shadow-sm)}')).toEqual(['shadow']);
    expect(lint('a{box-shadow:var(--shadow-lg), 0 0 0 2px var(--accent)}')).toEqual(['shadow']);
    expect(lint('a{box-shadow:var(--shadow-lg)}')).toEqual([]);
    expect(lint('a{box-shadow:none}')).toEqual([]);
    expect(lint('a{box-shadow:0 0 0 2px var(--accent)}')).toEqual([]);
    expect(lintCss('a{box-shadow:0 1px 2px var(--c)}', 'theme.css')).toEqual([]);
  });

  it('skips a line that carries ds-exempt', () => {
    expect(lint('a { color: #fff; } /* ds-exempt: brand mark */')).toEqual([]);
  });

  it('ignores comments', () => {
    expect(lint('/* color: #fff; padding: 3px */')).toEqual([]);
  });
});

describe('every stylesheet', () => {
  const files = cssFiles(ROOT);

  it.each(files)('%s stays on the design system', (file) => {
    const violations = lintCss(readFileSync(join(ROOT, file), 'utf8'), file);
    expect(violations.map((v) => `${v.file}:${v.line} ${v.rule} ${v.value}`)).toEqual([]);
  });

  it('keeps exemptions rare', () => {
    const count = files
      .map((f) => readFileSync(join(ROOT, f), 'utf8').split('ds-exempt:').length - 1)
      .reduce((a, b) => a + b, 0);
    expect(count).toBeLessThanOrEqual(MAX_EXEMPTIONS);
  });
});
