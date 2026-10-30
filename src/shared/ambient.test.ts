import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Anything that animates on its own goes through useAmbient, which stops it
 * when ambient motion is off, during focus, under Reduce Motion and in a
 * hidden tab (WCAG 2.2.2: a way to pause motion that runs for more than 5s).
 * Static, like the CSS lints: a file calling requestAnimationFrame must import
 * useAmbient or be listed here with the reason it is not ambient.
 */
const ROOT = join(__dirname, '..', '..');
const NOT_AMBIENT: Record<string, string> = {
  'src/pages/reader/components/PdfViewport.tsx': 'coalesces page renders, not an animation',
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [relative(ROOT, path)] : [];
  });
}

describe('ambient motion', () => {
  it.each(sources(join(ROOT, 'src')))('%s animates only through useAmbient', (file) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    if (!text.includes('requestAnimationFrame(') || file in NOT_AMBIENT) return;
    expect(text, `${file} calls requestAnimationFrame without useAmbient`).toMatch(/\buseAmbient\b/);
  });
});
