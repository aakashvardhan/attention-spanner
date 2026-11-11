import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Every rule that moves on a spring token, loops forever, or scales on press
 * or hover is stilled under Reduce Motion: its selector is listed again inside
 * the same stylesheet's `@media (prefers-reduced-motion: reduce)` block. Static, like the design
 * system lint: it reads source, so it never flakes. A rule meant to move
 * regardless says so with a `motion-exempt: <reason>` comment in its body,
 * which excuses that rule only, not its selector elsewhere.
 */

const ROOT = __dirname;
const REDUCE = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;

const selectorsOf = (text: string) => text.split(',').map((s) => s.replace(/\s+/g, ' ').trim());

/** Selectors of rules that use a spring token but are not stilled under Reduce Motion. */
function unstilled(source: string, moves = (body: string) => body.includes('var(--spring-')): string[] {
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
    if (moves(rule[2]) && !rule[2].includes(EXEMPT))
      out.push(...selectorsOf(rule[1]).filter((s) => !stilled.has(s)));
  }
  return out;
}

const COLOUR_PROPS = new Set([
  'color', 'background', 'background-color', 'border-color', 'box-shadow', 'outline-color', 'fill', 'stroke',
]);
const EFFECT_PROPS = new Set(['opacity', 'filter', 'backdrop-filter', ...COLOUR_PROPS]);

/**
 * Transition parts that put an effect on the wrong motion tokens. A colour or
 * a fade has no momentum, so it never rides a spring (Material 3 Expressive's
 * spatial/effects split), and a colour change always eases on the effects
 * tokens; a fade may travel with a chrome slide. Commas inside var() and
 * calc() do not split parts.
 */
function motionTokenMisuse(source: string): string[] {
  const EXEMPT = '__motion_exempt__';
  const css = source.replace(/\/\*[^*]*motion-exempt:[\s\S]*?\*\//g, EXEMPT).replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (rule[2].includes(EXEMPT)) continue;
    for (const m of rule[2].matchAll(/transition\s*:\s*([^;]+);?/g)) {
      for (const part of m[1].split(/,(?![^(]*\))/)) {
        const text = part.trim().replace(/\s+/g, ' ');
        const prop = text.split(' ')[0];
        if (EFFECT_PROPS.has(prop) && text.includes('var(--spring-')) out.push(text);
        else if (COLOUR_PROPS.has(prop) && !text.includes('var(--dur-effect-')) out.push(text);
      }
    }
  }
  return out;
}

const infinite = (body: string) => /\binfinite\b/.test(body);

/** Scales on press or hover, the motion a spring test cannot see when it eases on a curve. */
const scales = (body: string) => /(^|[;\s])scale\s*:|transform\s*:[^;]*\bscale\(/.test(body);
const pressOrHover = (selector: string) => /:(active|hover)\b/.test(selector);

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

describe('motionTokenMisuse', () => {
  it('flags a spring on an effect, including inside a list', () => {
    expect(
      motionTokenMisuse('.a { transition: transform 1s var(--spring-snappy), opacity var(--dur-snappy) var(--spring-snappy); }'),
    ).toEqual(['opacity var(--dur-snappy) var(--spring-snappy)']);
  });

  it('accepts effects on the effects tokens and springs on movement, commas inside calls included', () => {
    expect(
      motionTokenMisuse(
        '.a { transition: opacity var(--dur-effect-fast) var(--ease-effect), transform var(--dur-snappy) var(--spring-snappy) calc(var(--i) * 4ms); }',
      ),
    ).toEqual([]);
  });

  it('skips a rule carrying a motion-exempt reason', () => {
    expect(motionTokenMisuse('.a { transition: color 1s var(--spring-smooth); /* motion-exempt: why */ }')).toEqual([]);
  });

  it('keeps colour on the effects tokens, and lets a fade travel with a slide', () => {
    expect(motionTokenMisuse('.a { transition: background var(--dur-fast) var(--ease-out), color var(--dur-effect-fast) var(--ease-effect); }')).toEqual([
      'background var(--dur-fast) var(--ease-out)',
    ]);
    expect(motionTokenMisuse('.a { transition: opacity var(--dur-slow) var(--ease-out), transform var(--dur-slow) var(--ease-out); }')).toEqual([]);
  });
});

describe('unstilled press and hover scale', () => {
  it('flags a press scale Reduce Motion does not still, and ignores layout transforms and keyframes', () => {
    const press = '.b:active { transform: scale(0.96); }';
    expect(unstilled(press, scales).filter(pressOrHover)).toEqual(['.b:active']);
    expect(unstilled('.b:hover { scale: 1.3; }', scales).filter(pressOrHover)).toEqual(['.b:hover']);
    expect(unstilled(`${press}\n@media (prefers-reduced-motion: reduce) { .b:active { transform: none; } }`, scales)).toEqual([]);
    expect(unstilled('.t { transform: scale(calc(1 / var(--k))); }\n@keyframes k { to { scale: 0.8; } }', scales).filter(pressOrHover)).toEqual([]);
  });
});

describe('unstilled infinite animations', () => {
  it('flags an infinite animation Reduce Motion does not still, and accepts a stilled or exempt one', () => {
    expect(unstilled('.s { animation: spin 1s linear infinite; }', infinite)).toEqual(['.s']);
    expect(unstilled('.s { animation: spin 1s linear infinite; }\n@media (prefers-reduced-motion: reduce) { .s { animation: none; } }', infinite)).toEqual([]);
    expect(unstilled('.s { animation: spin 1s linear infinite; /* motion-exempt: why */ }', infinite)).toEqual([]);
  });
});

describe('every stylesheet', () => {
  it.each(cssFiles(ROOT))('%s stills its springs under reduced motion', (file) => {
    expect(unstilled(readFileSync(join(ROOT, file), 'utf8'))).toEqual([]);
  });

  it.each(cssFiles(ROOT))('%s keeps springs off colour, opacity and filter', (file) => {
    expect(motionTokenMisuse(readFileSync(join(ROOT, file), 'utf8'))).toEqual([]);
  });

  it.each(cssFiles(ROOT))('%s stills its infinite animations under reduced motion', (file) => {
    expect(unstilled(readFileSync(join(ROOT, file), 'utf8'), infinite)).toEqual([]);
  });

  it.each(cssFiles(ROOT))('%s stills what scales on press or hover under reduced motion', (file) => {
    expect(unstilled(readFileSync(join(ROOT, file), 'utf8'), scales).filter(pressOrHover)).toEqual([]);
  });
});

describe('the reader stays calm', () => {
  const css = readFileSync(join(ROOT, 'reader.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  it('marks the fovea with an edge and never animates it', () => {
    const at = css.indexOf('.reader-focus-band::before {');
    const rule = css.slice(at, css.indexOf('}', at));
    expect(rule).toMatch(/border-left: 2px solid var\(--accent\)/);
    expect(rule).not.toMatch(/animation|transition/);
  });

  it('sets the capsule numbers in the telemetry face', () => {
    expect(css).toMatch(/\.reader-capsule-summary \{[^}]*font-family: var\(--font-mono\);/);
  });
});
