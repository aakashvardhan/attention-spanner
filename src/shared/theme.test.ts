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
  });

  it('carries no skin blocks', () => {
    expect(css).not.toContain('data-skin');
  });
});
