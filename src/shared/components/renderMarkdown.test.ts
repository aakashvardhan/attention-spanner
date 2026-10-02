import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeTex, renderMarkdown } from './renderMarkdown';

describe('renderMarkdown', () => {
  it('renders Markdown structure', () => {
    const html = renderMarkdown('## Heading\n\n- one\n- two\n\n**bold** and `code`');
    expect(html).toContain('<h2');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
  });

  it('renders inline LaTeX as KaTeX markup', () => {
    const html = renderMarkdown('The gradient $\\nabla f$ points uphill.');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('$');
  });

  it('renders display LaTeX as a KaTeX block', () => {
    const html = renderMarkdown('Energy:\n\n$$E = mc^2$$');
    expect(html).toContain('katex-display');
  });

  it('preserves markdown characters inside math (no mangling)', () => {
    // The _ and ^ would be Markdown/subscript noise if math weren't lifted out first.
    const html = renderMarkdown('$a_i^2 + b_i^2$');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('<em>');
  });

  it('does not treat currency as math', () => {
    const html = renderMarkdown('It costs $5 and then $10 more.');
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('$5');
    expect(html).toContain('$10');
  });

  it('does not treat a price range as math', () => {
    // "$5–$10" used to lift "5–" into KaTeX, mangling the range and logging
    // an "Unrecognized Unicode character" warning for the en dash.
    for (const dash of ['–', '—', '-']) {
      const html = renderMarkdown(`Priced $5${dash}$10, or $20${dash}$30.`);
      expect(html).not.toContain('class="katex"');
      expect(html).toContain(`$5${dash}$10`);
      expect(html).toContain(`$20${dash}$30`);
    }
  });

  it('still renders real math that merely contains a dash', () => {
    expect(renderMarkdown('The range $1–5$ is inclusive.')).toContain('class="katex"');
  });

  it('drops raw HTML instead of rendering it', () => {
    const html = renderMarkdown('hi <img src=x onerror=alert(1)> there');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
  });

  it('drops javascript: links, keeping their text', () => {
    // marked does not filter link protocols; these render in extension pages,
    // where a click would run with chrome.* access.
    const html = renderMarkdown('[click me](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a');
    expect(html).toContain('click me');
  });

  it('drops javascript: in reference links and images', () => {
    const ref = renderMarkdown('[a][r]\n\n[r]: javascript:alert(1)');
    expect(ref).not.toContain('javascript:');
    expect(ref).not.toContain('<a');

    const img = renderMarkdown('![alt text](javascript:alert(1))');
    expect(img).not.toContain('javascript:');
    expect(img).not.toContain('<img');
    expect(img).toContain('alt text');
  });

  it('keeps http(s) links, opened without an opener handle', () => {
    const html = renderMarkdown('[arxiv](https://arxiv.org/abs/1706.03762)');
    expect(html).toContain('href="https://arxiv.org/abs/1706.03762"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('>arxiv</a>');
  });

  it('encodes quotes so a URL cannot break out of the attribute', () => {
    // The angle-bracket form is the one that carries a raw quote all the way
    // into href; the bare form stops at the quote in marked's own tokenizer.
    const html = renderMarkdown('[x](<https://a.example/" onmouseover="alert(1)>)');
    expect(html).not.toContain('onmouseover="');
    expect(html).toContain('%22');
  });

  it('does not double-encode an already-encoded URL', () => {
    const html = renderMarkdown('[x](https://a.example/a%20b)');
    expect(html).toContain('href="https://a.example/a%20b"');
  });

  it('renders inline markdown inside a link', () => {
    const html = renderMarkdown('[**bold** link](https://example.com)');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('href="https://example.com"');
  });

  it('does not throw on malformed math', () => {
    // KaTeX's throwOnError:false renders an error node instead of blowing up the
    // whole answer; the surrounding prose must still come through.
    const html = renderMarkdown('before $\\frac{1}{$ after');
    expect(html).toContain('before');
    expect(html).toContain('after');
  });

  it('returns empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });
});

describe('normalizeTex', () => {
  it('maps the Unicode KaTeX has no symbol for', () => {
    expect(normalizeTex('1–5')).toBe('1-5');
    expect(normalizeTex('1—5')).toBe('1-5');
    expect(normalizeTex('f’(x)')).toBe("f'(x)");
    expect(normalizeTex('x′')).toBe("x'");
    expect(normalizeTex('a b')).toBe('a b');
    // Braced so it does not run into the following letter as \mum
    expect(normalizeTex('5µm')).toBe('5{\\mu}m');
  });

  it('leaves the Unicode KaTeX already understands alone', () => {
    for (const tex of ['α≤β', 'a×b', '∞→0', 'a−b', '90°', 'x·y']) {
      expect(normalizeTex(tex)).toBe(tex);
    }
  });
});

describe('KaTeX strictness', () => {
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.join(' '));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders paper-shaped math without tripping strict mode', () => {
    // Every one of these used to log "LaTeX-incompatible input and strict mode
    // is set to 'warn': Unrecognized Unicode character".
    const html = renderMarkdown(
      'Ranges $1–5$ and $10—20$, primes $f’(x)$ and $y′$, scale $5µm$, spacing $a b$.',
    );
    expect(html).toContain('class="katex"');
    expect(warnings.filter((w) => w.includes('Unrecognized Unicode'))).toEqual([]);
    // KaTeX paints what it cannot parse in its error colour rather than
    // throwing (throwOnError: false). A substitution that yields an undefined
    // command — \mum instead of {\mu}m — shows up here and nowhere else.
    expect(html).not.toContain('#cc0000');
  });

  it('renders a price range without warning or KaTeX', () => {
    const html = renderMarkdown('That model costs $5–$10 per million tokens.');
    expect(html).not.toContain('class="katex"');
    expect(warnings).toEqual([]);
  });
});
