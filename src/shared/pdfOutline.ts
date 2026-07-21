/* Flattening a PDF's outline (table of contents) and mapping the current page
   to its nearest heading — the source of the auto-written "left off" note.
   pdf.js dest resolution is async, so the caller resolves dests up front and
   hands in a synchronous lookup; everything here stays pure. */

/** The shape pdf.js getOutline() returns (only the fields we use). */
export interface RawOutlineItem {
  title: string;
  dest: unknown;
  items?: RawOutlineItem[];
}

export interface FlatOutlineItem {
  title: string;
  /** Nesting depth, 0 for top-level sections */
  level: number;
  /** 1-based page the heading points at */
  page: number;
}

/**
 * Depth-first flatten. Items whose dest can't be resolved to a page are
 * dropped, but their children are still visited (at the deeper level).
 */
export function flattenOutline(
  items: RawOutlineItem[],
  pageForDest: (dest: unknown) => number | null,
): FlatOutlineItem[] {
  const out: FlatOutlineItem[] = [];
  const walk = (nodes: RawOutlineItem[], level: number): void => {
    for (const node of nodes) {
      const page = pageForDest(node.dest);
      if (page !== null) out.push({ title: node.title.trim(), level, page });
      if (node.items?.length) walk(node.items, level + 1);
    }
  };
  walk(items, 0);
  return out;
}

/**
 * The heading the reader is "in" on `page`: the nearest heading at or before
 * it. With several headings on one page the last (deepest into the document)
 * wins. Null before the first heading — the caller falls back to "Page N of M".
 */
export function headingForPage(flat: FlatOutlineItem[], page: number): string | null {
  let best: FlatOutlineItem | null = null;
  for (const item of flat) {
    if (item.page <= page && (best === null || item.page >= best.page)) best = item;
  }
  return best?.title ?? null;
}
