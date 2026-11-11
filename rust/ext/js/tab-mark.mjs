// Run in a webpage's tab by the side panel while Listen reads it
// (chrome.scripting executeScript `func`, ISOLATED world): marks the block a
// section starts with and brings it into view, so the page follows the voice.
// An empty needle clears the mark. Self-contained, as executeScript sends
// only the function's own source. The mark is a CSS custom highlight: the
// page's DOM is never changed, and a constructed stylesheet is not subject to
// the page's style-src policy. The DOM, the highlight registry and adopted
// sheets are shared with the page; our globals are not, so the page never
// sees them. The root and block selectors are page-text.js's (which cut the
// sections being matched); tests/tabScripts.test.ts keeps the two the same.

export function markSection(needle) {
  const NAME = 'reader-listen';
  if (!('highlights' in CSS)) return false;
  CSS.highlights.delete(NAME);
  if (!needle) return false;
  const squash = (t) => t.replace(/\s+/g, ' ').trim();
  const root = document.querySelector('article, main, [role=main]') || document.body;
  let found = null;
  for (const el of root.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, pre, blockquote, figcaption, dt, dd, td, th, div')) {
    // The innermost block that starts with these words, not the wrappers around it.
    if (squash(el.textContent).startsWith(needle) && (!found || found.contains(el))) found = el;
  }
  if (!found) return false;
  // Kept across calls in this world; added again if the page has since
  // replaced its adopted sheets (a flag alone would say it is still there).
  if (!window.__readerListenSheet) {
    window.__readerListenSheet = new CSSStyleSheet();
    window.__readerListenSheet.replaceSync(`::highlight(${NAME}) { background-color: Mark; color: MarkText; }`);
  }
  const sheet = window.__readerListenSheet;
  if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const range = document.createRange();
  range.selectNodeContents(found);
  CSS.highlights.set(NAME, new Highlight(range));
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  found.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
  return true;
}

// Handed to Rust as a value, to pass on as executeScript's `func`.
export const markFn = () => markSection;
