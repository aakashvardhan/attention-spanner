import type { Reference } from '../../shared/bibliography';
import type { DocCitations } from '../../shared/docCitations';
import { paperMatchKey } from '../../shared/papers';
import { articleReaderPath, paperPdfSource, readerPagePath } from '../../shared/pdf';
import type { Paper } from '../../shared/types';

/**
 * Which citations in a document point at something the reader already has.
 *
 * This is the distinction that makes a reference list feel like a wiki rather
 * than a bibliography: a link that goes somewhere looks different from one that
 * does not, and following it lands on your own copy — with your highlights on
 * it — instead of bouncing out to arXiv.
 */

export interface KnownTarget {
  /** 'paper' — tracked, with status and progress; 'read' — opened at least once */
  kind: 'paper' | 'read';
  title: string;
  /**
   * Extension-relative path, not an absolute URL: `chrome.runtime.getURL` is
   * unavailable outside the extension, and keeping this pure is what lets the
   * resolution rules be tested. The component resolves it at render.
   */
  path: string;
  /** The paper's own URL when the reader cannot show it (no PDF to point at) */
  externalUrl: string;
}

/**
 * The stable identity behind a bibliography entry, or null when it has no
 * link we could resolve. Built on `paperMatchKey`, so an entry citing the
 * arXiv abs page and one citing the versioned PDF collapse to one key.
 */
export function refMatchKey(ref: Reference): string | null {
  return ref.link ? paperMatchKey(ref.link) : null;
}

/**
 * Index everything the reader owns by match key.
 *
 * Tracked papers are written last and therefore win: a paper carries status,
 * progress and a deck, where a merely-opened document carries only the fact
 * that it was opened once. When both describe the same work, the richer one is
 * the one worth linking to.
 */
export function indexKnownRefs(
  papers: readonly Paper[],
  docs: Record<string, DocCitations>,
): Map<string, KnownTarget> {
  const known = new Map<string, KnownTarget>();

  for (const doc of Object.values(docs)) {
    known.set(doc.docKey, {
      kind: 'read',
      title: doc.title,
      path: articleReaderPath(doc.docUrl),
      externalUrl: doc.docUrl,
    });
  }

  for (const paper of papers) {
    const key = paperMatchKey(paper.url) ?? (paper.pdf ? paperMatchKey(paper.pdf.url) : null);
    if (!key) continue;
    const pdf = paperPdfSource(paper);
    known.set(key, {
      kind: 'paper',
      title: paper.title,
      path: pdf ? readerPagePath(pdf) : '',
      externalUrl: paper.url,
    });
  }

  return known;
}

/** What a citation marker resolves to locally, if anything. */
export function knownTargetFor(
  ref: Reference,
  known: Map<string, KnownTarget>,
): KnownTarget | null {
  const key = refMatchKey(ref);
  return key ? (known.get(key) ?? null) : null;
}
