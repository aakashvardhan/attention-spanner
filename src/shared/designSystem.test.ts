import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Every stylesheet stays on the design system in theme.css: colors through
 * tokens, spacing on the 4px grid, type and radii from their scales. Static on
 * purpose: it reads source, so it is fast and never flaky. A justified
 * exception carries `ds-exempt: <reason>` in a comment on the same line.
 */

export interface Violation {
  file: string;
  line: number;
  rule: 'color' | 'spacing' | 'font-size' | 'line-height' | 'font-weight' | 'radius';
  value: string;
}

const ROOT = join(__dirname, '..', '..');
const THEME = 'src/shared/theme.css';
const MAX_EXEMPTIONS = 12;

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const NAMED_COLOR = /\b(white|black|red|green|blue|orange|gray|grey|yellow|purple|pink)\b/;
const COLOR_PROPS = /^(color|background(-color)?|border(-[a-z]+)*|outline(-color)?|fill|stroke|box-shadow|text-decoration-color|caret-color|accent-color)$/;
const SPACING_PROPS = /^((margin|padding|inset)(-[a-z-]+)?|gap|row-gap|column-gap|top|right|bottom|left|grid-template-(columns|rows))$/;
const PX = /(-?\d*\.?\d+)px/g;

/** Blank out comments but keep every newline, so line numbers survive. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

export function lintCss(source: string, file: string): Violation[] {
  const exempt = new Set(
    source.split('\n').flatMap((l, i) => (l.includes('ds-exempt:') ? [i + 1] : [])),
  );
  const lines = stripComments(source).split('\n');
  const out: Violation[] = [];
  const isTheme = file === THEME;
  lines.forEach((text, i) => {
    const line = i + 1;
    if (exempt.has(line)) return;
    // Every declaration on the line, so one-line rules (`a { padding: 6px; }`) count too.
    const decls = [...text.matchAll(/(?:^|[{;])\s*(-{0,2}[a-z][a-z0-9-]*)\s*:\s*([^;{}]+)/g)];
    // Continuation lines of a multi-line value (box-shadow stacks) still carry colors.
    if (decls.length === 0) {
      if (!isTheme && COLOR_LITERAL.test(text)) out.push({ file, line, rule: 'color', value: text.trim() });
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
    }
  });
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
    expect(lint('a {\n  box-shadow: 0 0 0 1px var(--border),\n    0 4px 8px rgba(0,0,0,.2);\n}')).toEqual(['color']);
    expect(lint('a { border-color: white; }')).toEqual(['color']);
    expect(lintCss('a { color: #fff; }', 'src/shared/theme.css')).toEqual([]);
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
    expect(lint('a { font-size: 13px; }')).toEqual(['font-size']);
    expect(lint('a { line-height: 1.5; }')).toEqual(['line-height']);
    expect(lint('a { font-weight: 600; }')).toEqual(['font-weight']);
    expect(lint('a { font-size: var(--text-sm); line-height: var(--leading-sm); font-weight: 700; }')).toEqual([]);
  });

  it('holds radii to tokens', () => {
    expect(lint('a { border-radius: 6px; }')).toEqual(['radius']);
    expect(lint('a { border-radius: var(--radius-lg) var(--radius-lg) 0 0; }')).toEqual([]);
  });

  it('skips a line that carries ds-exempt', () => {
    expect(lint('a { color: #fff; } /* ds-exempt: brand mark */')).toEqual([]);
  });

  it('ignores comments', () => {
    expect(lint('/* color: #fff; padding: 3px */')).toEqual([]);
  });
});

describe('every stylesheet', () => {
  const files = cssFiles(join(ROOT, 'src'));

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
