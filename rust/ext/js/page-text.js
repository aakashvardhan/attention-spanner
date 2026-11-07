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

  // Exponents and indices written as HTML (pass^k = p<sup>k</sup>) would
  // otherwise read as "pk". A footnote mark that is a link is dropped.
  for (const el of root.querySelectorAll('sup, sub')) {
    if (el.querySelector('a')) {
      el.remove();
      continue;
    }
    const t = el.textContent.replace(/\s+/g, ' ').trim();
    const mark = el.tagName === 'SUP' ? '^' : '_';
    el.replaceWith(document.createTextNode(/^\w+$/.test(t) ? `${mark}${t}` : `${mark}(${t})`));
  }

  root
    .querySelectorAll(
      'nav, header, footer, aside, script, style, noscript, button, svg, template, [hidden], [aria-hidden="true"], ' +
        '[role=navigation], [role=banner], [role=contentinfo], [role=complementary], [role=search]',
    )
    .forEach((el) => el.remove());

  // One walk in document order. Headings, pre and leaf blocks (p, li, ... with
  // no block inside) are blocks of their own; any other text, loose in a div,
  // or a list item's own words before its sublist, gathers until the next
  // block boundary.
  const HEAD = 'h1, h2, h3, h4, h5, h6';
  const ALL = `${HEAD}, p, li, pre, blockquote, figcaption, dt, dd, td, th`;
  const INLINE = new Set('A ABBR B BDI BDO CITE CODE DATA DFN EM FONT I KBD LABEL MARK Q S SAMP SMALL SPAN STRONG TIME U VAR WBR'.split(' '));
  const squash = (t) => t.replace(/\s+/g, ' ').trim();
  const blocks = [];
  let loose = '';
  const flush = () => {
    const t = squash(loose);
    if (t) blocks.push({ level: 0, text: t });
    loose = '';
  };
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) {
        loose += c.data;
      } else if (c.nodeType !== Node.ELEMENT_NODE) {
        continue;
      } else if (c.tagName === 'BR') {
        loose += ' ';
      } else if (c.matches(HEAD)) {
        flush();
        const t = squash(c.textContent);
        if (t) blocks.push({ level: Number(c.tagName[1]), text: t });
      } else if (c.tagName === 'PRE') {
        flush();
        const t = c.textContent.replace(/\s+$/, '');
        if (t.trim()) blocks.push({ level: 0, text: t });
      } else if (INLINE.has(c.tagName)) {
        walk(c);
      } else if (c.matches(ALL) && !c.querySelector(ALL)) {
        flush();
        const t = squash(c.textContent);
        if (t) blocks.push({ level: 0, text: t });
      } else {
        flush();
        walk(c);
        flush();
      }
    }
  };
  walk(root);
  flush();
  const h1 = blocks.find((b) => b.level === 1);
  return { title: h1 ? h1.text : document.title, blocks };
})();
