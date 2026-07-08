import { useCallback, useMemo } from 'react';
import { sendMessage } from '../messages';
import type { Paper, PaperDraft } from '../types';
import { useStorageValue } from './useStorageValue';

/**
 * Research papers grouped into decks (shared with flashcards). Writes go through
 * the service worker; the papers page and the dashboard card render from the
 * same storage.
 */
export function usePapers() {
  const [papers] = useStorageValue('papers');

  /** deckId → papers, most recently updated first */
  const byDeck = useMemo(() => {
    const map = new Map<string, Paper[]>();
    for (const paper of papers) {
      const list = map.get(paper.deckId) ?? [];
      list.push(paper);
      map.set(paper.deckId, list);
    }
    for (const list of map.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
    return map;
  }, [papers]);

  /** Currently-reading papers, most recently opened first (dashboard "Reading now") */
  const readingNow = useMemo(
    () =>
      papers
        .filter((p) => p.status === 'reading')
        .sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0)),
    [papers],
  );

  const toReadCount = useMemo(() => papers.filter((p) => p.status === 'to-read').length, [papers]);

  const addPaper = useCallback((draft: PaperDraft) => sendMessage({ type: 'PAPER_ADD', draft }), []);
  const updatePaper = useCallback(
    (id: string, patch: Partial<PaperDraft>) => sendMessage({ type: 'PAPER_UPDATE', id, patch }),
    [],
  );
  const deletePaper = useCallback((id: string) => sendMessage({ type: 'PAPER_DELETE', id }), []);

  return { papers, byDeck, readingNow, toReadCount, addPaper, updatePaper, deletePaper };
}
