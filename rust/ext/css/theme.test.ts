import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The palette tokens, held to WCAG 2.2 AAA: every text colour on
 * every surface it can land on clears 7:1, and the focus ring and filled
 * controls clear 3:1 (WCAG 2.4.13 / 1.4.11). Paper is :root; every alternate
 * palette (:root[data-theme='x']) is held to the same rules.
 */

const css = readFileSync(join(__dirname, 'theme.css'), 'utf8');

/** `--name: value` pairs declared directly inside the block that opens with `selector {`. */
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing block ${selector}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf('\n}', start));
  return new Map([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const tokens = block(':root');
const get = (k: string): string => {
  const v = tokens.get(k);
  expect(v, `missing ${k}`).toBeDefined();
  const ref = v!.match(/^var\((--[a-z0-9-]+)\)$/);
  return ref ? get(ref[1]) : v!;
};

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const SURFACES = ['--bg-page', '--bg-surface', '--bg-subtle', '--bg-hover', '--accent-soft', '--accent-wash'];
const TEXT = ['--text-primary', '--text-secondary', '--text-muted', '--accent-text'];

const PALETTES = ['paper', ...[...css.matchAll(/:root\[data-theme='([a-z]+)'\] \{/g)].map((m) => m[1])];

describe.each(PALETTES)('%s: WCAG AAA', (palette) => {
  const over = palette === 'paper' ? new Map<string, string>() : block(`:root[data-theme='${palette}']`);
  const get = (k: string): string => {
    const v = over.get(k) ?? tokens.get(k);
    expect(v, `missing ${k}`).toBeDefined();
    const ref = v!.match(/^var\((--[a-z0-9-]+)\)$/);
    return ref ? get(ref[1]) : v!;
  };

  it.each(TEXT.flatMap((fg) => SURFACES.map((bg) => [fg, bg])))('%s on %s clears 7:1', (fg, bg) => {
    expect(contrast(get(fg), get(bg))).toBeGreaterThanOrEqual(7);
  });

  it.each([
    ['--on-accent', '--accent'],
    ['--on-accent', '--accent-hover'],
    ['--danger', '--danger-bg'],
    ['--danger', '--bg-surface'],
    // The primary button: ink with cream text
    ['--bg-page', '--rule'],
    // The blocked page
    ['--focus-text', '--focus-bg'],
    ['--focus-text-secondary', '--focus-bg'],
    ['--focus-accent', '--focus-bg'],
  ])('%s on %s clears 7:1', (fg, bg) => {
    expect(contrast(get(fg), get(bg))).toBeGreaterThanOrEqual(7);
  });

  it.each(SURFACES)('the brass focus ring clears 3:1 on %s', (bg) => {
    expect(contrast(get('--accent'), get(bg))).toBeGreaterThanOrEqual(3);
  });

  it('paper is never pure white (glare), ink never pure black', () => {
    for (const k of ['--bg-page', '--bg-surface']) expect(get(k).toLowerCase()).not.toBe('#ffffff');
    expect(get('--text-primary').toLowerCase()).not.toBe('#000000');
  });

  it('outlines are found at a glance: --border clears 3:1 on the card surfaces', () => {
    for (const bg of ['--bg-page', '--bg-surface']) expect(contrast(get('--border'), get(bg)), bg).toBeGreaterThanOrEqual(3);
  });

  it('the recoloured PDF reads like the rest of the room', () => {
    expect(contrast(get('--pdf-ink'), get('--pdf-paper'))).toBeGreaterThanOrEqual(12);
  });

  it('the heatmap steps from paper to deep brass, each step visible', () => {
    // Light palettes darken toward brass; grid (dark) brightens toward cyan.
    const lum = [0, 1, 2, 3, 4].map((i) => luminance(get(`--heat-${i}`)));
    const dir = Math.sign(lum[4] - lum[0]);
    for (let i = 1; i < 5; i++) expect(Math.sign(lum[i] - lum[i - 1]), `heat-${i}`).toBe(dir);
    for (let i = 1; i < 5; i++)
      expect(contrast(get(`--heat-${i - 1}`), get(`--heat-${i}`)), `heat-${i - 1} → ${i}`).toBeGreaterThanOrEqual(1.2);
  });
});

describe('the break room: WCAG AAA', () => {
  const brk = block(":root[data-phase='break']");
  const bget = (k: string): string => brk.get(k) ?? get(k);
  it.each(TEXT.flatMap((fg) => SURFACES.map((bg) => [fg, bg])))('%s on %s clears 7:1', (fg, bg) => {
    expect(contrast(bget(fg), bget(bg))).toBeGreaterThanOrEqual(7);
  });
  it.each([
    ['--on-accent', '--accent'],
    ['--on-accent', '--accent-hover'],
    ['--bg-page', '--rule'],
  ])('%s on %s clears 7:1', (fg, bg) => {
    expect(contrast(bget(fg), bget(bg))).toBeGreaterThanOrEqual(7);
  });
  it.each(SURFACES)('the sage focus ring clears 3:1 on %s', (bg) => {
    expect(contrast(bget('--accent'), bget(bg))).toBeGreaterThanOrEqual(3);
  });
});

describe('theme structure', () => {
  it('paper is light; grid is the only dark palette; no focus room or skin blocks', () => {
    expect(css).not.toMatch(/data-skin|round-progress|data-phase='focus'/);
    expect([...css.matchAll(/color-scheme: dark/g)].length).toBe(1);
    expect(PALETTES.length).toBeGreaterThan(1);
    expect(css.match(/:root \{\n {2}color-scheme: (\w+)/)?.[1]).toBe('light');
  });

  it('the Settings picker lists exactly these palettes', () => {
    const rs = readFileSync(join(__dirname, '../src/pages/mod.rs'), 'utf8');
    const list = rs.slice(rs.indexOf('pub const THEMES'), rs.indexOf('];', rs.indexOf('pub const THEMES')));
    expect([...list.matchAll(/\("([a-z]+)",/g)].map((m) => m[1]).sort()).toEqual([...PALETTES].sort());
  });

  it('puts spacing, radii and leading on the 4px grid', () => {
    for (const [k, v] of tokens) {
      if (!/^--(space|radius|leading|grid-gutter|grid-margin)/.test(k) || k === '--radius-pill') continue;
      expect(parseFloat(v) % 4, `${k}: ${v}`).toBe(0);
    }
  });

  it('pairs every text size with a leading', () => {
    const sizes = [...tokens].filter(([k, v]) => k.startsWith('--text-') && v.endsWith('px')).map(([k]) => k.slice(7));
    expect(sizes).toEqual(['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl']);
    for (const s of sizes) expect(tokens.has(`--leading-${s}`), s).toBe(true);
  });

  it('every colour token a stylesheet reads is declared', () => {
    const sheets = readdirSync(__dirname).filter((f) => f.endsWith('.css'));
    // Set at runtime: inline by the Rust views (heatmap tooltip, settings index
    // bar, card progress, clock hands, each reader page's --scale-factor in
    // viewport.rs) or by pdf.js (--min-font-size on the text layer).
    const runtime = ['--x', '--y', '--p', '--h', '--m', '--s', '--indicator-y', '--indicator-h', '--scale-factor', '--min-font-size'];
    const declared = new Set([...css.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]).concat(runtime));
    const missing = new Set<string>();
    for (const sheet of sheets) {
      const text = readFileSync(join(__dirname, sheet), 'utf8');
      // Locally scoped custom properties (set and read in the same sheet) are fine.
      const local = new Set([...text.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
      for (const m of text.matchAll(/var\((--[a-z0-9-]+)/g)) if (!declared.has(m[1]) && !local.has(m[1])) missing.add(`${sheet}: ${m[1]}`);
    }
    expect([...missing]).toEqual([]);
  });

  it('every token it declares is read: by a stylesheet, or by name from the Rust or JS', () => {
    const sheets = readdirSync(__dirname).filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(__dirname, f), 'utf8'));
    const code = ['../src', '../js'].flatMap((dir) =>
      (readdirSync(join(__dirname, dir), { recursive: true }) as string[])
        .filter((f) => /\.(rs|js|mjs)$/.test(f))
        .map((f) => readFileSync(join(__dirname, dir, f), 'utf8')),
    );
    const read = (t: string) => sheets.some((s) => s.includes(`var(${t})`) || s.includes(`var(${t},`)) || code.some((c) => c.includes(`"${t}"`) || c.includes(`'${t}'`));
    const unread = [...new Set([...css.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]))].filter((t) => !read(t));
    expect(unread).toEqual([]);
  });

  it('--text-faint stays decorative: it never colours a word or a control, only rules, ticks and list markers', () => {
    const sheets = readdirSync(__dirname).filter((f) => f.endsWith('.css') && f !== 'theme.css');
    const offenders = sheets.flatMap((sheet) => {
      const text = readFileSync(join(__dirname, sheet), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((r) => /(^|[;\s])color\s*:\s*var\(--text-faint\)/.test(r[2]) && !/::marker\s*$/.test(r[1].trim()))
        .map((r) => `${sheet}: ${r[1].trim()}`);
    });
    expect(offenders).toEqual([]);
  });
});
