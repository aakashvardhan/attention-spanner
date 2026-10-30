import { useEffect, useState } from 'react';
import { getDocument, VerbosityLevel, type PDFDocumentProxy } from 'pdfjs-dist';
import { flattenOutline, type FlatOutlineItem, type RawOutlineItem } from '../../shared/pdfOutline';

/** Documents up to this many pages are sized before the reader opens. */
const EAGER_SIZE_PAGES = 300;

/** Page size at scale 1 (PDF points × the default 1.0 viewport). */
export interface PdfPageSize {
  width: number;
  height: number;
}

export type PdfLoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      doc: PDFDocumentProxy;
      pageSizes: PdfPageSize[];
      outline: FlatOutlineItem[];
      /** Title from the PDF metadata, '' when absent */
      title: string;
    };

/** Outline dests resolve async in pdf.js; build a sync lookup for flattenOutline. */
async function resolveOutlinePages(
  doc: PDFDocumentProxy,
  items: RawOutlineItem[],
): Promise<Map<unknown, number>> {
  const pages = new Map<unknown, number>();
  const walk = async (nodes: RawOutlineItem[]): Promise<void> => {
    for (const node of nodes) {
      try {
        const explicit = typeof node.dest === 'string' ? await doc.getDestination(node.dest) : node.dest;
        if (Array.isArray(explicit) && explicit[0]) {
          pages.set(node.dest, (await doc.getPageIndex(explicit[0])) + 1);
        }
      } catch {
        // Broken dest — the item is dropped by flattenOutline.
      }
      if (node.items?.length) await walk(node.items);
    }
  };
  await walk(items);
  return pages;
}

/**
 * Fetch the PDF and open it with pdf.js. Cross-origin fetch works from an
 * extension page under host_permissions; credentials ride along so
 * institution-gated PDFs come through. A non-PDF response (paywall HTML behind
 * a .pdf URL) becomes an error state instead of a parser crash.
 */
export function usePdfDocument(src: string): PdfLoadState {
  const [state, setState] = useState<PdfLoadState>({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    let loadingTask: ReturnType<typeof getDocument> | null = null;

    (async () => {
      let data: ArrayBuffer;
      try {
        const res = await fetch(src, { credentials: 'include' });
        if (!res.ok) throw new Error(`The server answered ${res.status}.`);
        data = await res.arrayBuffer();
      } catch (error) {
        if (alive) {
          setState({ status: 'error', message: `Couldn't download the PDF. ${(error as Error).message}` });
        }
        return;
      }
      // The spec allows junk before the header; %PDF- within the first 1 KB is
      // the same leniency real viewers apply.
      const head = new TextDecoder('latin1').decode(new Uint8Array(data, 0, Math.min(1024, data.byteLength)));
      if (!head.includes('%PDF-')) {
        if (alive) {
          setState({
            status: 'error',
            message: "This link didn't return a PDF (probably a login or landing page).",
          });
        }
        return;
      }

      try {
        // Real-world PDFs make pdf.js warn about junk it recovers from anyway
        // ("minus sign in the middle", missing glyphs). Those warnings land in
        // the extension's error list and bury the ones that matter; failures
        // still throw and land in the catch below.
        // wasmUrl: without it scanned (CCITT/JBIG2) and JPEG 2000 pages render blank.
        loadingTask = getDocument({
          data,
          verbosity: VerbosityLevel.ERRORS,
          wasmUrl: new URL('/pdfjs/', location.href).href,
        });
        const doc = await loadingTask.promise;
        const sizeOf = async (n: number): Promise<PdfPageSize> => {
          const { width, height } = (await doc.getPage(n)).getViewport({ scale: 1 });
          return { width, height };
        };
        // Sizing every page costs ~0.4 ms each in the worker (1.9 s at 5000
        // pages). Big documents open on page 1's size and settle in the
        // background; small ones are fast enough to size up front.
        const progressive = doc.numPages > EAGER_SIZE_PAGES;
        const allSizes = (): Promise<PdfPageSize[]> =>
          Promise.all(Array.from({ length: doc.numPages }, (_, i) => sizeOf(i + 1)));
        const [pageSizes, outline, meta] = await Promise.all([
          progressive
            ? sizeOf(1).then((first) => Array.from({ length: doc.numPages }, () => first))
            : allSizes(),
          (async () => {
            const rawOutline = ((await doc.getOutline()) ?? []) as unknown as RawOutlineItem[];
            const destPages = await resolveOutlinePages(doc, rawOutline);
            return flattenOutline(rawOutline, (dest) => destPages.get(dest) ?? null);
          })(),
          doc.getMetadata().catch(() => null) as Promise<{ info?: { Title?: string } } | null>,
        ]);
        if (!alive) return;
        const title = meta?.info?.Title ?? '';
        setState({ status: 'ready', doc, pageSizes, outline, title });
        if (progressive) {
          // ponytail: one layout shift when sizes differ; chunked updates if it bothers.
          const real = await allSizes().catch(() => null);
          const first = pageSizes[0];
          if (alive && real?.some((s) => s.width !== first.width || s.height !== first.height)) {
            setState({ status: 'ready', doc, pageSizes: real, outline, title });
          }
        }
      } catch (error) {
        if (alive) {
          setState({ status: 'error', message: `Couldn't open the PDF. ${(error as Error).message}` });
        }
      }
    })();

    return () => {
      alive = false;
      // Also destroys the document proxy; StrictMode's double-mount relies on this.
      void loadingTask?.destroy();
    };
  }, [src]);

  return state;
}
