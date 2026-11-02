// pdf.js, behind the smallest surface Rust needs. Plumbing only: every
// decision about what comes back (captions, outline, layout, progress) is made
// in Rust. pdf.js ships unmodified under /pdfjs/ (scripts/rust-assets.mjs).
//
// Shapes returned:
//   openPdf(bytes)        → doc
//   pageSize(doc, n)      → { width, height } at scale 1
//   outline(doc)          → [{ title, page|null, items: [...] }]  (dests resolved)
//   title(doc)            → string ('' when absent)
//   pageTexts(doc)        → string[]  (line breaks rebuilt)
//   pageLines(doc)        → [[{ text, y }]]  (y = 0-1 down the page of the line's first item)
//   renderPage(doc, n, canvas, scale, thumb) → { promise, cancel() }
//   textLayer(doc, n, container, scale)      → { promise, cancel() }
//   pageLinks(doc, n, scale) → [{ left, top, width, height, url?, dest? }]
//   resolveDest(doc, dest)   → { page, offset } | null
//
// pdf.js loads with the first document, not with this module: every page and
// the service worker share one wasm module and so import this file, and only
// the reader needs pdf.js. Everything else takes a doc, so it runs after openPdf.
let pdfjs = null;

export async function openPdf(bytes) {
  if (!pdfjs) {
    pdfjs = await import('/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
  }
  // wasmUrl: without it scanned (CCITT/JBIG2) and JPEG 2000 pages render blank.
  // Warnings about junk pdf.js recovers from would bury real errors.
  return pdfjs.getDocument({ data: bytes, verbosity: pdfjs.VerbosityLevel.ERRORS, wasmUrl: '/pdfjs/' }).promise;
}

export async function pageSize(doc, n) {
  const { width, height } = (await doc.getPage(n)).getViewport({ scale: 1 });
  return { width, height };
}

export async function outline(doc) {
  const walk = async (nodes) =>
    Promise.all(
      (nodes ?? []).map(async (node) => {
        let page = null;
        try {
          const explicit = typeof node.dest === 'string' ? await doc.getDestination(node.dest) : node.dest;
          if (Array.isArray(explicit) && explicit[0]) page = (await doc.getPageIndex(explicit[0])) + 1;
        } catch {
          // a broken dest: Rust drops the item, keeps its children
        }
        return { title: node.title ?? '', page, items: await walk(node.items) };
      }),
    );
  return walk(await doc.getOutline());
}

export async function title(doc) {
  const meta = await doc.getMetadata().catch(() => null);
  return meta?.info?.Title ?? '';
}

async function eachPage(doc, f) {
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) out.push(await f(await doc.getPage(n)));
  return out;
}

export function pageTexts(doc) {
  return eachPage(doc, async (page) => {
    let text = '';
    for (const item of (await page.getTextContent()).items) {
      if (typeof item.str !== 'string') continue;
      text += item.str;
      if (item.hasEOL) text += '\n';
    }
    return text;
  });
}

export function pageLines(doc) {
  return eachPage(doc, async (page) => {
    const viewport = page.getViewport({ scale: 1 });
    const lines = [];
    let text = '';
    let y = null;
    const flush = () => {
      if (y !== null) lines.push({ text, y });
      text = '';
      y = null;
    };
    for (const item of (await page.getTextContent()).items) {
      if (typeof item.str !== 'string') continue;
      if (y === null && item.str.trim() && item.transform) {
        y = viewport.convertToViewportPoint(item.transform[4], item.transform[5])[1] / viewport.height;
      }
      text += item.str;
      if (item.hasEOL) flush();
    }
    flush();
    return lines;
  });
}

export function renderPage(doc, n, canvas, scale, thumb) {
  let task = null;
  let cancelled = false;
  const promise = (async () => {
    const page = await doc.getPage(n);
    if (cancelled) return;
    // Cap the backing resolution: full dpr × zoom canvases are megabytes each.
    const dpr = thumb ? 1 : Math.min(globalThis.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: scale * dpr });
    // Paint off-screen and swap in when done: resizing the visible canvas clears it.
    const off = document.createElement('canvas');
    off.width = Math.floor(viewport.width);
    off.height = Math.floor(viewport.height);
    task = page.render({ canvas: off, canvasContext: off.getContext('2d'), viewport });
    try {
      await task.promise;
    } catch {
      return; // cancelled
    }
    if (cancelled) return;
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext('2d').drawImage(off, 0, 0);
    canvas.dataset.ready = 'true';
  })();
  return { promise, cancel: () => { cancelled = true; task?.cancel(); } };
}

export function textLayer(doc, n, container, scale) {
  let layer = null;
  let cancelled = false;
  const promise = (async () => {
    const page = await doc.getPage(n);
    if (cancelled) return;
    container.replaceChildren();
    layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport: page.getViewport({ scale }) });
    await layer.render().catch(() => undefined);
  })();
  return { promise, cancel: () => { cancelled = true; layer?.cancel(); } };
}

export async function pageLinks(doc, n, scale) {
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale });
  const links = [];
  for (const a of await page.getAnnotations({ intent: 'display' })) {
    if (a.subtype !== 'Link' || !(a.url || a.dest)) continue;
    const [x1, y1] = viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
    const [x2, y2] = viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
    links.push({ left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), url: a.url ?? null, dest: a.dest ?? null });
  }
  return links;
}

export async function resolveDest(doc, dest) {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!explicit?.length) return null;
    const [ref, mode, ...args] = explicit;
    const index = typeof ref === 'number' ? ref : await doc.getPageIndex(ref);
    const page = await doc.getPage(index + 1);
    // XYZ is [left, top, zoom], FitH/FitBH are [top]; anything else lands on the page top.
    const top = mode?.name === 'XYZ' ? args[1] : mode?.name === 'FitH' || mode?.name === 'FitBH' ? args[0] : null;
    if (typeof top !== 'number') return { page: index + 1, offset: 0 };
    const viewport = page.getViewport({ scale: 1 });
    const [, y] = viewport.convertToViewportPoint(0, top);
    return { page: index + 1, offset: Math.min(1, Math.max(0, y / viewport.height)) };
  } catch {
    return null; // a broken destination is a dead link, not a crash
  }
}
