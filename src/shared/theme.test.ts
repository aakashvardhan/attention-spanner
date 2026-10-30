import { describe, expect, it } from 'vitest';
import { resolveTheme } from './theme';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('resolveTheme', () => {
  it('explicit modes ignore the OS preference', () => {
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
  });

  it('paperwhite ignores the OS preference', () => {
    expect(resolveTheme('paperwhite', true)).toBe('paperwhite');
  });

  it('system follows the OS preference', () => {
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
  });
});

const css = readFileSync(join(__dirname, 'theme.css'), 'utf8');

/** `--name: value` pairs declared directly inside the block that opens with `selector {`. */
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing block ${selector}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf('\n}', start));
  return new Map([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const light = block(':root');
const dark = block(":root[data-theme='dark']");
const paperwhite = new Map([...light, ...block(":root[data-theme='paperwhite']")]);
const breakLight = new Map([...light, ...block(":root[data-phase='break']")]);
const breakDark = new Map([...dark, ...block(":root[data-theme='dark'][data-phase='break']")]);

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

describe('theme tokens', () => {
  it('dark overrides every themed color the light block declares', () => {
    const themed = [...light].filter(([k, v]) => !k.startsWith('--focus-') && /#|rgba?\(/.test(v)).map(([k]) => k);
    const missing = themed.filter((k) => !dark.has(k));
    expect(missing).toEqual([]);
    const extra = [...dark.keys()].filter((k) => !light.has(k));
    expect(extra).toEqual([]);
  });

  it('paperwhite activity grid steps from paper to ink, one visible step at a time', () => {
    const t = paperwhite;
    const lum = [0, 1, 2, 3, 4].map((i) => luminance(t.get(`--heat-${i}`)!));
    for (let i = 1; i < 5; i++) expect(lum[i - 1] - lum[i], `heat-${i}`).toBeGreaterThan(0);
    for (let i = 1; i < 5; i++) {
      expect(contrast(t.get(`--heat-${i - 1}`)!, t.get(`--heat-${i}`)!), `heat-${i - 1} → ${i}`).toBeGreaterThanOrEqual(1.1);
    }
  });

  it('paperwhite grid cells are cut from its own paper, not the cream theme', () => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(paperwhite.get('--heat-0')!.slice(i, i + 2), 16));
    // Warm like the page: red over green over blue, with a clear yellow lean.
    expect(r > g && g > b && r - b > 40, paperwhite.get('--heat-0')).toBe(true);
  });

  it('paperwhite overrides only colors the light block declares', () => {
    const pw = block(":root[data-theme='paperwhite']");
    expect([...pw.keys()].filter((k) => !light.has(k))).toEqual([]);
  });

  it('puts spacing, radii and leading on the 4px grid', () => {
    for (const [k, v] of light) {
      if (!/^--(space|radius|leading|grid-gutter|grid-margin)/.test(k) || k === '--radius-pill') continue;
      expect(parseFloat(v) % 4, `${k}: ${v}`).toBe(0);
    }
  });

  it('pairs every text size with a leading', () => {
    // Size tokens only: --text-primary and friends are colors, not sizes.
    const sizes = [...light].filter(([k, v]) => k.startsWith('--text-') && v.endsWith('px')).map(([k]) => k.slice(7));
    expect(sizes).toEqual(['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl']);
    for (const s of sizes) expect(light.has(`--leading-${s}`), s).toBe(true);
  });

  it.each([
    ['light', light],
    ['dark', dark],
    ['paperwhite', paperwhite],
    ['break', breakLight],
    ['dark break', breakDark],
  ] as const)('%s text clears contrast floors', (_, t) => {
    const get = (k: string) => (t.get(k) ?? light.get(k))!;
    const body: [string, string][] = [
      ['--text-primary', '--bg-page'],
      ['--text-primary', '--bg-surface'],
      ['--text-secondary', '--bg-page'],
      ['--text-secondary', '--bg-surface'],
      ['--text-muted', '--bg-page'],
      ['--text-muted', '--bg-surface'],
      ['--text-muted', '--bg-subtle'],
      ['--on-accent', '--accent'],
      ['--accent-text', '--bg-surface'],
      // Status text sits on its own tinted wash (chips, feedback), not on the
      // page; axe caught two of these below 4.5:1 when only the page was checked.
      ['--accent-text', '--accent-wash'],
      ['--success', '--success-bg'],
      ['--warning', '--warning-bg'],
      ['--danger', '--danger-bg'],
      // A hovered chip
      ['--text-primary', '--accent-border'],
    ];
    for (const [fg, bg] of body) expect(contrast(get(fg), get(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(get('--accent'), get('--bg-page')), 'accent on page').toBeGreaterThanOrEqual(3);
    // The PDF's own ink on its paper is the body text of every paper read here.
    expect(contrast(get('--pdf-ink'), get('--pdf-paper')), 'pdf ink on paper').toBeGreaterThanOrEqual(12);
  });

  it('the focus room still clears contrast at the warm end of a round', () => {
    const warmEnd = '#1a120c';
    for (const fg of ['--text-primary', '--text-secondary', '--text-muted']) {
      expect(contrast(dark.get(fg)!, warmEnd), fg).toBeGreaterThanOrEqual(4.5);
    }
    expect(css).toContain(`#0e0c0b, ${warmEnd} calc(var(--round-progress, 0) * 100%)`);
  });

  it('carries no skin blocks', () => {
    expect(css).not.toContain('data-skin');
  });
});
