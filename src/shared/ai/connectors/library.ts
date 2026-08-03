import { notesLocked } from '../../notesLock';
import { importPrivateKey, open } from '../../notesVault';
import { articleReaderUrl, recordingReaderUrl } from '../../pdf';
import { transcriptText } from '../../recordings';
import { getLocal, getSession } from '../../storage';
import { formatHit, searchLibrary, type LibraryDoc, type LibraryHit } from '../library';
import type { Connector, SourceRef } from './base';

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
  const { annotations, notes, papers, recordings, notesVault } = await getLocal(
    'annotations',
    'notes',
    'papers',
    'recordings',
    'notesVault',
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

  // A locked brain dump stays out of the assistant's reach too — otherwise the
  // passcode only hides notes from the eye, not from "what did I write about X".
  // While locked there is nothing to hide anyway: these are ciphertext.
  const { notesPrivateKey } = await getSession('notesPrivateKey');
  const hideNotes = notesLocked(notesVault !== null, notesPrivateKey !== '');
  const noteKey = hideNotes || !notesPrivateKey ? null : await importPrivateKey(notesPrivateKey);

  for (const n of hideNotes ? [] : notes) {
    let text: string;
    if (n.encRaw === undefined) {
      text = [n.rawText, ...n.bullets].join(' ');
    } else if (noteKey) {
      try {
        text = [
          await open(n.encRaw, noteKey, n.id),
          n.encBullets ? (JSON.parse(await open(n.encBullets, noteKey, n.id)) as string[]) : [],
        ]
          .flat()
          .join(' ');
      } catch {
        continue; // sealed by a vault that no longer exists
      }
    } else {
      continue;
    }
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

  // What was said, alongside what was written. The summary leads because it is
  // the part phrased for retrieval; the transcript behind it is what actually
  // answers "did the professor mention X".
  for (const r of recordings) {
    const text = [r.summary, ...r.actionItems, transcriptText(r)].filter(Boolean).join(' ');
    if (!text.trim()) continue;
    docs.push({
      id: r.id,
      kind: 'recording',
      title: r.title,
      text,
      url: recordingReaderUrl(r.id),
      at: r.startedAt,
    });
  }

  return docs;
}

/** Search and format for a prompt; '' when nothing matched. */
export async function searchLibraryText(query: string, limit = MAX_HITS): Promise<string> {
  const hits = searchLibrary(await gatherLibrary(), query, limit);
  return hits.map((h) => formatHit(h, HIT_CHARS)).join('\n');
}

/**
 * A hit as a citable source. The library already carries everything a citation
 * needs — id, kind, title, url — so this is handing over what the search found
 * rather than reconstructing it from the formatted text, which is exactly what
 * keeps a cited source traceable to something real.
 */
export function hitToSource(hit: LibraryHit): SourceRef {
  return {
    id: '',
    kind: hit.kind,
    title: hit.title,
    url: hit.url,
    snippet: hit.text.replace(/\s+/g, ' ').trim().slice(0, HIT_CHARS),
  };
}

export const libraryConnector: Connector = {
  id: 'library',
  label: 'Library',
  isAvailable: () => true,
  tools: [
    {
      name: 'search_library',
      loop: 'auto',
      description:
        'Search what the user has read, written, and recorded — highlights and notes from articles and papers, brain dumps, and transcripts of recorded lectures and meetings. Use for "what did I highlight about X", "what have I read on X", "find my note about X", "what was said about X in my lectures".',
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
        const query = p.query as string;
        const hits = searchLibrary(await gatherLibrary(), query, MAX_HITS);
        if (hits.length === 0) return `Nothing in your library matches “${query}”.`;
        return {
          text: hits.map((h) => formatHit(h, HIT_CHARS)).join('\n'),
          sources: hits.map(hitToSource),
        };
      },
    },
  ],
};
