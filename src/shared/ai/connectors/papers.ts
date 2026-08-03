import { sendMessage } from '../../messages';
import { normalizeTitle, paperMatchKey } from '../../papers';
import { getLocal } from '../../storage';
import type { PaperDraft } from '../../types';
import { resolvePaperDeckId, type Connector } from './base';

/**
 * The local reading list — the counterpart to `alphaxivConnector`, which only
 * touches alphaXiv's cloud folder. Tracking a paper here turns on progress
 * tracking (the in-extension reader ratchets it) and makes the paper searchable
 * via `search_library`. Wraps the existing PAPER_ADD RPC, so no new background
 * capability is introduced.
 */
export const papersConnector: Connector = {
  id: 'papers',
  label: 'Papers',
  isAvailable: () => true,
  tools: [
    {
      name: 'add_paper',
      description:
        "Track a research paper in the user's reading list so its reading progress is saved and it turns up in search_library (\"add the RETRO paper to my reading list\", \"track 2406.09246\"). This is the local deck — not save_paper_to_alphaxiv, which only touches the alphaXiv cloud folder.",
      params: {
        type: 'object',
        required: ['title'],
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'The paper title', maxLength: 300 },
          url: {
            type: 'string',
            description: 'arXiv id, DOI, or paper URL (optional)',
            maxLength: 500,
          },
          authors: {
            type: 'string',
            description: 'Comma-separated author names (optional)',
            maxLength: 300,
          },
          year: {
            type: 'number',
            description: 'Publication year (optional)',
            minimum: 1900,
            maximum: 2100,
          },
          deck: { type: 'string', description: 'Papers deck to add to (optional)', maxLength: 100 },
        },
      },
      confirm: true,
      palette: {
        label: 'Track a paper',
        keywords: ['paper', 'track', 'read', 'arxiv', 'research'],
        argPlaceholder: 'a title or arXiv id',
      },
      summary: (p) => `Track “${p.title as string}”`,
      run: async (p) => {
        const title = (p.title as string).trim();
        const url = ((p.url as string) ?? '').trim();

        // Don't create a duplicate: the same paper may already be tracked under
        // another link (project page vs arXiv vs DOI) or the same title.
        const { papers } = await getLocal('papers');
        const key = url ? paperMatchKey(url) : null;
        const titleKey = normalizeTitle(title);
        const dup = papers.find(
          (pp) =>
            (key !== null && paperMatchKey(pp.url) === key) || normalizeTitle(pp.title) === titleKey,
        );
        if (dup) return `“${dup.title}” is already in your reading list.`;

        const deckId = await resolvePaperDeckId(p.deck as string | undefined);
        const draft: PaperDraft = {
          deckId,
          title,
          authors: (p.authors as string) ?? '',
          venue: '',
          year: (p.year as number | undefined) ?? null,
          citations: null,
          url,
          abstract: '',
          relevance: '',
          status: 'to-read',
          progressPercent: 0,
          leftOff: '',
        };
        const res = await sendMessage({ type: 'PAPER_ADD', draft });
        if (!res.ok) throw new Error(res.error ?? 'Could not track the paper.');
        return `Tracking “${title}”.`;
      },
    },
  ],
};
