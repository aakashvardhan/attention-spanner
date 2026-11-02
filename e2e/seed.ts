import type { Folder, Paper } from '../src/shared/types';

const HOUR = 60 * 60_000;

export const folder: Folder = { id: '01985f0e-9788-7c5f-9cff-fbf84379ca7a', name: 'Reading', type: 'default-reading' };

/** A shelved arXiv paper; `n` picks a distinct id like 2601.00001. */
export function paper(n: string, title: string, overrides: Partial<Paper> = {}): Paper {
  const now = Date.now();
  const id = `2601.${n.padStart(5, '0')}`;
  return {
    id,
    title,
    authors: 'A. Author',
    year: 2026,
    url: `https://arxiv.org/abs/${id}`,
    folderIds: [folder.id],
    progressPercent: 30,
    leftOff: '',
    addedAt: now - 48 * HOUR,
    updatedAt: now - HOUR,
    lastReadAt: now - HOUR,
    ...overrides,
  };
}
