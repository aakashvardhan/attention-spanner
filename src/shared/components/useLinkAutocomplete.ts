import { useMemo, useState } from 'react';
import { LINK_SUGGESTIONS } from '../constants';
import { useStorageValue } from '../hooks/useStorageValue';
import { normalizeTitle } from '../papers';

/**
 * Typing `[[` offers the things already in your graph.
 *
 * This is what decides whether wiki links get used at all: nobody types
 * `[[Denoising Diffusion Probabilistic Models]]` from memory, and a link that
 * misspells its target silently resolves to nothing. Completing from real
 * titles means the link is correct by construction.
 */

export interface LinkSuggestion {
  title: string;
  kind: string;
}

/** The open `[[` immediately before the caret, and what has been typed into it. */
export function openLink(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf('[[');
  if (start < 0) return null;
  const inner = before.slice(start + 2);
  // A closed link, or one already broken across lines, is not still being typed.
  if (inner.includes(']]') || inner.includes('\n')) return null;
  return { start, query: inner };
}

/** Replace the open `[[query` with a completed `[[Title]] `. */
export function completeLink(text: string, caret: number, title: string): string {
  const open = openLink(text, caret);
  if (!open) return text;
  return `${text.slice(0, open.start)}[[${title}]] ${text.slice(caret)}`;
}

export function useLinkAutocomplete(text: string, caret: number) {
  const [graphNodes] = useStorageValue('graphNodes');
  const [papers] = useStorageValue('papers');
  const [dismissed, setDismissed] = useState('');

  const open = openLink(text, caret);
  const query = open?.query ?? '';

  const suggestions = useMemo(() => {
    if (!open || dismissed === `${open.start}`) return [];

    // Papers first: they are what a note is most often about, and the graph
    // node for one may not exist yet on a fresh library.
    const titles = new Map<string, string>();
    for (const p of papers) if (p.title.trim()) titles.set(normalizeTitle(p.title), 'paper');
    for (const n of graphNodes) {
      const key = normalizeTitle(n.title);
      if (n.title.trim() && !titles.has(key)) titles.set(key, n.kind);
    }

    const q = normalizeTitle(query);
    const all = [...papers.map((p) => p.title), ...graphNodes.map((n) => n.title)];
    const seen = new Set<string>();
    const out: LinkSuggestion[] = [];

    for (const title of all) {
      const key = normalizeTitle(title);
      if (!key || seen.has(key)) continue;
      // An empty query offers the most recent; otherwise anything containing it.
      if (q && !key.includes(q)) continue;
      seen.add(key);
      out.push({ title, kind: titles.get(key) ?? 'article' });
      if (out.length === LINK_SUGGESTIONS) break;
    }
    return out;
  }, [open, dismissed, query, graphNodes, papers]);

  return {
    suggestions,
    /** Escape closes the list without closing the note being written. */
    dismiss: () => setDismissed(open ? `${open.start}` : ''),
    complete: (title: string) => completeLink(text, caret, title),
  };
}
