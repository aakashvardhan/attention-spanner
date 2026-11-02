import { describe, expect, it } from 'vitest';
import { structure } from './lib/blocks';
import spec from './fixtures/commonmark-0.31.2.json';

// Headings and code inside quotes and list items are part of that block by design (spec, Index entry), so those examples are out.
const examples = spec.filter((e) => !/<(blockquote|li|ul|ol)\b/.test(e.html));

describe('oracle: the CommonMark spec', () => {
  it.each(examples)('example $example ($section) has the headings and code blocks the spec expects', (e) => {
    const s = structure(e.markdown);
    const headings = [...e.html.matchAll(/<h([1-6])>([\s\S]*?)<\/h\1>/g)].map((m) => ({ level: Number(m[1]), text: m[2] }));
    expect(s.headings.map((h) => h.level)).toEqual(headings.map((h) => h.level));
    headings.forEach((h, i) => {
      // Inline markup is the inline parser's business; compare text only when neither side has any.
      if (!/[<&\\`*_]/.test(h.text) && !/[<&\\`*_]/.test(s.headings[i].text)) expect(s.headings[i].text).toBe(h.text);
    });
    expect(s.blocks.filter((b) => b.kind === 'code')).toHaveLength([...e.html.matchAll(/<pre><code[^>]*>/g)].length);
  });
});
