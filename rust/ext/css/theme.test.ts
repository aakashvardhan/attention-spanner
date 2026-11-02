import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The walnut-and-brass tokens, held to WCAG 2.2 AAA: every text colour on
 * every surface it can land on clears 7:1, and the focus ring and filled
 * controls clear 3:1 (WCAG 2.4.13 / 1.4.11). One theme, so one block.
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

export function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const SURFACES = ['--bg-page', '--bg-surface', '--bg-subtle', '--bg-hover', '--accent-soft', '--accent-wash'];
const TEXT = ['--text-primary', '--text-secondary', '--text-muted', '--accent-text'];

describe('walnut and brass: WCAG AAA', () => {
  it.each(TEXT.flatMap((fg) => SURFACES.map((bg) => [fg, bg])))('%s on %s clears 7:1', (fg, bg) => {
    expect(contrast(get(fg), get(bg))).toBeGreaterThanOrEqual(7);
  });

  it.each([
    ['--on-accent', '--accent'],
    ['--on-accent', '--accent-hover'],
    ['--success', '--success-bg'],
    ['--warning', '--warning-bg'],
    ['--danger', '--danger-bg'],
    ['--success', '--bg-surface'],
    ['--danger', '--bg-surface'],
    // The primary button: cream with walnut text
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

  it('cream is never pure white, walnut never pure black (halation)', () => {
    expect(get('--text-primary').toLowerCase()).not.toBe('#ffffff');
    expect(get('--bg-page').toLowerCase()).not.toBe('#000000');
  });

  it('the recoloured PDF reads like the rest of the room', () => {
    expect(contrast(get('--pdf-ink'), get('--pdf-paper'))).toBeGreaterThanOrEqual(12);
  });

  it('the heatmap steps from walnut to brass, each step visible', () => {
    const lum = [0, 1, 2, 3, 4].map((i) => luminance(get(`--heat-${i}`)));
    for (let i = 1; i < 5; i++) expect(lum[i], `heat-${i}`).toBeGreaterThan(lum[i - 1]);
    for (let i = 1; i < 5; i++)
      expect(contrast(get(`--heat-${i - 1}`), get(`--heat-${i}`)), `heat-${i - 1} → ${i}`).toBeGreaterThanOrEqual(1.2);
  });
});

describe('theme structure', () => {
  it('is one theme: no light/dark/paperwhite, focus/break room or skin blocks', () => {
    expect(css).not.toMatch(/data-theme|data-phase|data-skin|round-progress/);
    expect(tokens.get('color-scheme') ?? css.match(/:root \{\n {2}color-scheme: (\w+)/)?.[1]).toBe('dark');
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
    // Set at runtime: by JS (heatmap tooltip, settings index bar) or by pdf.js (text layer).
    const runtime = ['--x', '--y', '--indicator-y', '--indicator-h', '--scale-factor', '--min-font-size'];
    const declared = new Set([...css.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]).concat(runtime));
    const missing = new Set<string>();
    for (const sheet of sheets) {
      let text = '';
      try {
        text = readFileSync(join(__dirname, sheet), 'utf8');
      } catch {
        continue;
      }
      // Locally scoped custom properties (set and read in the same sheet) are fine.
      const local = new Set([...text.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
      for (const m of text.matchAll(/var\((--[a-z0-9-]+)/g)) if (!declared.has(m[1]) && !local.has(m[1])) missing.add(`${sheet}: ${m[1]}`);
    }
    expect([...missing]).toEqual([]);
  });
});
