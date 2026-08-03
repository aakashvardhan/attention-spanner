import { allReferences, type ReferenceIndex } from './bibliography';
import { MAX_DOC_REF_KEYS, MAX_INDEXED_DOCS } from './constants';
import { paperMatchKey } from './papers';

/**
 * "What links here", built out of documents the user has actually opened.
 *
 * Every PDF the reader opens already gets its bibliography parsed. Keeping a
 * compact projection of that turns it into a reverse index: which of the papers
 * I have read cite this one. Narrower than a global citation index, and for
 * tracking your own corpus frequently the more useful answer — it is the
 * difference between "203 papers cite this" and "you have read three of them".
 *
 * Only match keys are stored, never entry text: about 40 keys at 40 characters
 * is ~2 KB per document, so the whole index stays well under a megabyte, and
 * the display text is always recoverable from the document that owns it.
 */

export interface DocCitations {
  /** annotationDocKey(src) — the same identity annotations use for this document */
  docKey: string;
  docUrl: string;
  title: string;
  /** paperMatchKey of each resolvable bibliography entry */
  refKeys: string[];
  indexedAt: number;
}

/**
 * The match keys a parsed bibliography yields. An entry with no extractable
 * link produces nothing — a key we cannot form is not a citation we can ever
 * resolve, and inventing one from the title text would match the wrong paper.
 */
export function refKeysFrom(index: ReferenceIndex, cap = MAX_DOC_REF_KEYS): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const ref of allReferences(index)) {
    if (!ref.link) continue;
    const key = paperMatchKey(ref.link);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    if (keys.length === cap) break;
  }
  return keys;
}

/**
 * The documents whose reference lists contain this paper, newest first.
 *
 * A document never cites itself: a paper's own bibliography routinely contains
 * entries that resolve back to it (self-citations, an earlier preprint of the
 * same work), and "cited by: itself" is a bug a reader spots instantly.
 */
export function backlinksFor(
  matchKey: string | null,
  docs: Record<string, DocCitations>,
): DocCitations[] {
  if (!matchKey) return [];
  return Object.values(docs)
    .filter((doc) => doc.docKey !== matchKey && doc.refKeys.includes(matchKey))
    .sort((a, b) => b.indexedAt - a.indexedAt);
}

/** Oldest-first eviction. The index is a convenience, so it never grows without bound. */
export function pruneDocCitations(
  docs: Record<string, DocCitations>,
  cap = MAX_INDEXED_DOCS,
): Record<string, DocCitations> {
  const all = Object.values(docs);
  if (all.length <= cap) return docs;

  const keep = all.sort((a, b) => b.indexedAt - a.indexedAt).slice(0, cap);
  return Object.fromEntries(keep.map((doc) => [doc.docKey, doc]));
}
