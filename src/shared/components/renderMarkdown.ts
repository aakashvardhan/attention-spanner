import katex from 'katex';
import { marked, type Tokens } from 'marked';

/**
 * Render an assistant answer as Markdown with LaTeX math. Papers are full of
 * both — the reader's answers need headings, bullets, `code`, and real
 * equations, not the plain text the chat bubble used to show. Pure string work
 * (no DOM), so it's unit-tested; the CSS and the React wrapper live in
 * Markdown.tsx.
 *
 * Raw HTML is dropped and link/image targets are protocol-checked (the text is
 * model- and paper-sourced, so a stray tag or a javascript: href has no
 * business rendering); everything else is standard GFM plus KaTeX.
 */

/** The only protocols allowed to reach an href/src attribute. */
const SAFE_PROTOCOL = /^(?:https?:|mailto:)/i;

/**
 * Attribute-safe URL. encodeURI hides any quote that would otherwise break out
 * of the attribute; re-decoding %25 keeps an already-encoded URL from being
 * double-escaped (marked's own cleanUrl does exactly this).
 */
function safeUrl(href: string): string | null {
  if (!SAFE_PROTOCOL.test(href.trim())) return null;
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null; // malformed surrogate pair
  }
}

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    // Content isn't trusted HTML — dropping raw tags is the whole sanitizer we need.
    html: () => '',
    // marked stopped filtering link protocols, so `javascript:` survives its
    // parser. These render inside extension pages, where a click would run
    // with full chrome.* access — the default CSP blocks that, but it should
    // not be the only thing standing in the way. An unsafe target degrades to
    // its own text rather than vanishing.
    link({ href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      const url = safeUrl(href);
      if (!url) return text;
      const attr = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
      // Extension pages have nowhere to go back to — open elsewhere, and deny
      // the opened page a window.opener handle onto this one.
      return `<a href="${url}"${attr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    image({ href, title, text }: Tokens.Image) {
      const url = safeUrl(href);
      const alt = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      if (!url) return alt;
      const attr = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
      return `<img src="${url}" alt="${alt}"${attr}>`;
    },
  },
});

interface Math {
  display: boolean;
  tex: string;
}

// $$…$$ and \[…\] are displayed; $…$ and \(…\) are inline. The $…$ branch
// requires non-space just inside the delimiters so prose like "$5 and $10"
// isn't mistaken for math — and non-dash too, or the price range "$5–$10"
// parses as the formula "5–" followed by a stray "10".
const MATH_RE =
  /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?!\s)([^\n$]+?)(?<![\s–—-])\$/g;

/**
 * Unicode KaTeX has no symbol for. Model- and paper-sourced text is full of
 * these — a typographic dash in a range, a curly apostrophe, a non-breaking
 * space — and each one logs "Unrecognized Unicode character" and renders as a
 * fallback glyph. Mapping them to the LaTeX they meant renders properly and
 * keeps the console clean. Everything else KaTeX already knows: Greek, arrows,
 * ≤ ≥ ≈ ≠ ±, °, ×, ÷, ∞, · all pass through untouched.
 */
const TEX_UNICODE: Record<string, string> = {
  '‐': '-', // hyphen
  '–': '-', // en dash
  '—': '-', // em dash
  '‘': "'", // left single quote
  '’': "'", // right single quote / apostrophe — prime, which is the usual intent
  '′': "'", // prime
  '“': '\\text{"}', // left double quote — \text so it isn't read as a double prime
  '”': '\\text{"}', // right double quote
  ' ': ' ', // non-breaking space
  ' ': ' ', // thin space
  // Braced, not a bare \mu: "5µm" would otherwise become the undefined
  // command \mum rather than \mu followed by m.
  'µ': '{\\mu}', // micro sign (not the Greek mu KaTeX accepts)
};
const TEX_UNICODE_RE = new RegExp(`[${Object.keys(TEX_UNICODE).join('')}]`, 'g');

/** Pure: make one formula's Unicode punctuation LaTeX-compatible. */
export function normalizeTex(tex: string): string {
  return tex.replace(TEX_UNICODE_RE, (ch) => TEX_UNICODE[ch]);
}

export function renderMarkdown(text: string): string {
  if (!text) return '';

  // Lift math out before Markdown parsing so `_`, `*`, `\` inside a formula
  // aren't mangled as Markdown, then splice KaTeX back over the placeholders.
  // The placeholders are NUL-wrapped so they survive parsing and can't collide
  // with real content.
  const math: Math[] = [];
  const staged = text.replace(MATH_RE, (_, dd, db, ip, is) => {
    const tex = (dd ?? db ?? ip ?? is) as string;
    const idx = math.push({ display: dd !== undefined || db !== undefined, tex }) - 1;
    return `\x00KMATH${idx}\x00`;
  });

  const html = marked.parse(staged) as string;

  return html.replace(/\x00KMATH(\d+)\x00/g, (_, n) => {
    const m = math[Number(n)];
    try {
      return katex.renderToString(normalizeTex(m.tex), {
        displayMode: m.display,
        throwOnError: false,
      });
    } catch {
      // Unparseable math shows verbatim rather than vanishing.
      return m.display ? `$$${m.tex}$$` : `$${m.tex}$`;
    }
  });
}
