// Injected into a tab by the side panel (chrome.scripting.executeScript). Its
// last expression is the result: the page's main content as blocks, with
// rendered math swapped back for the LaTeX it came from. Works on a copy;
// the live page is never changed.
(() => {
  const root = (document.querySelector('article, main, [role=main]') || document.body).cloneNode(true);
  const tex = (el) => el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
  const swap = (el, t, display) => el.replaceWith(document.createTextNode(display ? ` $$${t}$$ ` : ` $${t}$ `));

  // KaTeX: display first, so its inner .katex isn't swapped on its own.
  for (const el of root.querySelectorAll('.katex-display')) {
    const t = tex(el);
    if (t) swap(el, t, true);
  }
  for (const el of root.querySelectorAll('.katex')) {
    const t = tex(el);
    if (t) swap(el, t, false);
  }
  // MathJax 2 keeps the source in a script; drop its rendered copies.
  root.querySelectorAll('.MathJax_Preview, .MathJax, .MathJax_Display, .MathJax_SVG, .MathJax_SVG_Display, .MathJax_CHTML').forEach((el) => el.remove());
  for (const el of root.querySelectorAll('script[type^="math/tex"]')) {
    swap(el, el.textContent.trim(), el.type.includes('mode=display'));
  }
  // MathJax 3 and bare MathML: TeX if it was kept, else the alt text, else the MathML's text.
  for (const el of root.querySelectorAll('mjx-container, math')) {
    if (!el.isConnected) continue;
    const m = el.matches('math') ? el : el.querySelector('math');
    const t = tex(el) || m?.getAttribute('alttext') || m?.textContent?.trim() || '';
    const display = el.getAttribute('display') === 'true' || m?.getAttribute('display') === 'block';
    if (t) swap(el, t, display);
    else el.remove();
  }

  root
    .querySelectorAll('nav, header, footer, aside, script, style, noscript, form, button, svg, template, [hidden], [aria-hidden="true"]')
    .forEach((el) => el.remove());

  const HEAD = 'h1, h2, h3, h4, h5, h6';
  const BODY = 'p, li, pre, blockquote, figcaption, dt, dd, td';
  const ALL = `${HEAD}, ${BODY}`;
  const blocks = [];
  for (const el of root.querySelectorAll(ALL)) {
    // A block that holds another block lets the inner one speak.
    if (!el.matches(HEAD) && el.querySelector(ALL)) continue;
    const pre = el.matches('pre');
    const raw = el.textContent || '';
    const text = pre ? raw.replace(/\s+$/, '') : raw.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    blocks.push({ level: el.matches(HEAD) ? Number(el.tagName[1]) : 0, text });
  }
  const h1 = blocks.find((b) => b.level === 1);
  return { title: h1 ? h1.text : document.title, blocks };
})();
