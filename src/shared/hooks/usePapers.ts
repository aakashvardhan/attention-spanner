import { useMemo } from 'react';
import type { Paper } from '../types';
import { useStorageValue } from './useStorageValue';

/** Papers grouped by alphaXiv folder id, most recently read first within each. */
export function groupByFolder(papers: readonly Paper[]): Map<string, Paper[]> {
  const map = new Map<string, Paper[]>();
  for (const paper of papers)
    for (const id of paper.folderIds) map.set(id, [...(map.get(id) ?? []), paper]);
  for (const list of map.values()) list.sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0));
  return map;
}

/** The shelf: alphaXiv folders and their papers, read from the local mirror. */
export function usePapers() {
  const [papers] = useStorageValue('papers');
  const [folders] = useStorageValue('folders');
  const byFolder = useMemo(() => groupByFolder(papers), [papers]);
  /** The paper read most recently (new tab "Continue reading"), or null */
  const lastRead = useMemo(
    () => papers.filter((p) => p.lastReadAt).sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0))[0] ?? null,
    [papers],
  );
  return { papers, folders, byFolder, lastRead };
}
