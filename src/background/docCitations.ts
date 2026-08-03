import { pruneDocCitations, type DocCitations } from '../shared/docCitations';
import { getLocal, setLocal } from '../shared/storage';

/**
 * The chrome-touching half of the reverse citation index. The rules live in
 * shared/docCitations.ts; every write goes through the service worker so two
 * reader tabs opening at once cannot clobber each other's entry.
 */

/**
 * Record what a document cites. Re-indexing the same document overwrites its
 * entry rather than merging: a bibliography is a property of the document, so
 * the newest parse is simply the best one we have.
 *
 * An entry citing nothing is still stored. "We looked and found no resolvable
 * references" is a different fact from "we have never opened this", and only
 * the stored entry can tell the two apart.
 */
export async function indexDocCitations(entry: DocCitations): Promise<{ ok: boolean }> {
  if (!entry.docKey) return { ok: false };

  const { docCitations } = await getLocal('docCitations');
  const next = { ...docCitations, [entry.docKey]: entry };
  await setLocal({ docCitations: pruneDocCitations(next) });
  return { ok: true };
}
