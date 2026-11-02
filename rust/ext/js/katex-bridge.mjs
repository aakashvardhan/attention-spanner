// KaTeX, loaded on first use: ~600 KB that most pages never need. Every page
// shares one wasm module (and so this file), so a static import would load it
// on every new tab. KaTeX ships unmodified under /katex/ (scripts/rust-assets.mjs).
let katex = null;

export async function loadKatex() {
  katex ??= (await import('/katex/katex.mjs')).default;
}

/** HTML for one formula, or null when KaTeX is not loaded or cannot parse it. */
export function renderTex(tex, display) {
  if (!katex) return null;
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false });
  } catch {
    return null;
  }
}
