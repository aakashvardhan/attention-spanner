import { articleReaderUrl } from '../../pdf';
import { getLocal } from '../../storage';
import { formatHit, searchLibrary, type LibraryDoc } from '../library';
import type { Connector } from './base';

/** How many hits a search returns, and how much of each is quoted back. */
const MAX_HITS = 5;
const HIT_CHARS = 240;

/**
 * Everything the user has written down or marked up, flattened into one
 * searchable list. Read fresh per search: the collections are small (capped
 * at a couple of thousand annotations) and a stale index would be worse than
 * a few milliseconds of work.
 */
export async function gatherLibrary(): Promise<LibraryDoc[]> {
  const { annotations, notes, papers, meetingNotes } = await getLocal(
    'annotations',
    'notes',
    'papers',
    'meetingNotes',
  );
  const docs: LibraryDoc[] = [];

  for (const a of annotations) {
    const text = [a.text, a.note].filter(Boolean).join(' — ');
    if (!text.trim()) continue;
    docs.push({
      id: a.id,
      kind: 'highlight',
      title: a.docUrl,
      text,
      url: a.anchor.kind === 'text' ? articleReaderUrl(a.docUrl) : a.docUrl,
      at: a.updatedAt,
    });
  }

  for (const n of notes) {
    const text = [n.rawText, ...n.bullets].join(' ');
    if (!text.trim()) continue;
    docs.push({
      id: n.id,
      kind: 'note',
      title: `Brain dump ${new Date(n.createdAt).toLocaleDateString()}`,
      text,
      url: '',
      at: n.createdAt,
    });
  }

  for (const p of papers) {
    docs.push({
      id: p.id,
      kind: 'paper',
      title: p.title,
      text: [p.abstract, p.relevance, p.leftOff].filter(Boolean).join(' '),
      url: p.url,
      at: p.lastReadAt ?? p.updatedAt,
    });
  }

  for (const m of meetingNotes.notes) {
    docs.push({
      id: m.id,
      kind: 'meeting',
      title: m.title,
      text: m.blocks.map((b) => ('text' in b ? b.text : '')).join(' '),
      url: m.url,
      at: m.dateMs,
    });
  }

  return docs;
}

/** Search and format for a prompt; '' when nothing matched. */
export async function searchLibraryText(query: string, limit = MAX_HITS): Promise<string> {
  const hits = searchLibrary(await gatherLibrary(), query, limit);
  return hits.map((h) => formatHit(h, HIT_CHARS)).join('\n');
}

export const libraryConnector: Connector = {
  id: 'library',
  label: 'Library',
  isAvailable: () => true,
  tools: [
    {
      name: 'search_library',
      description:
        'Search what the user has read and written — highlights and notes from articles and papers, brain dumps, and meeting notes. Use for "what did I highlight about X", "what have I read on X", "find my note about X".',
      params: {
        type: 'object',
        required: ['query'],
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            description: 'The words to search for',
            maxLength: 200,
          },
        },
      },
      palette: {
        label: 'Search my library',
        keywords: ['search', 'find', 'highlight', 'note', 'read'],
        argPlaceholder: 'what to look for',
      },
      summary: (p) => `Search the library for “${p.query as string}”`,
      run: async (p) => {
        const found = await searchLibraryText(p.query as string);
        return found || `Nothing in your library matches “${p.query as string}”.`;
      },
    },
  ],
};
