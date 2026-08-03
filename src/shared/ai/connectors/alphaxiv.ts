import {
  arxivIdFrom,
  formatDiscoveredPapers,
  formatPageExcerpts,
  parseDiscoveredPapers,
  parsePagesXml,
} from '../../alphaxiv';
import type { DiscoveredPaper } from '../../alphaxiv';
import { sendMessage } from '../../messages';
import type { Connector, SourceRef } from './base';

/**
 * alphaXiv research tools. These reach outside the user's own library — where
 * `libraryConnector` searches what you've already read, these search the arXiv
 * corpus, read a paper, and answer questions about one with page citations.
 *
 * Every call is slow (server-side models) and counts against the user's alphaXiv
 * quota, so nothing here runs unattended: no automation or monitor path calls
 * these, and the one write is confirm-gated.
 */

/** Both `text` and a friendly failure come back from the background. */
async function ax(
  message: Parameters<typeof sendMessage>[0],
  emptyNote: string,
): Promise<string> {
  const res = (await sendMessage(message)) as { ok: boolean; text?: string; error?: string };
  if (!res.ok) throw new Error(res.error ?? 'alphaXiv could not answer that.');
  return res.text?.trim() || emptyNote;
}

/**
 * A discovered paper as a citable source. The title, authors and URL are what
 * alphaXiv actually returned, so a citation points at a paper that exists —
 * this is the field where inventing plausible references is most tempting and
 * most damaging.
 */
/**
 * A citable source for a paper the user named, when — and only when — a real
 * URL can be derived from what they said. A bare title gives us nothing to
 * link to, and the right answer there is no citation rather than a guessed one.
 */
function refSource(input: string): SourceRef[] {
  const id = arxivIdFrom(input);
  if (id) return [{ id: '', kind: 'paper', title: `arXiv:${id}`, url: `https://arxiv.org/abs/${id}` }];
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return [{ id: '', kind: 'paper', title: trimmed, url: trimmed }];
  return [];
}

function paperSource(paper: DiscoveredPaper): SourceRef {
  const year = paper.published.slice(0, 4);
  return {
    id: '',
    kind: 'paper',
    title: [paper.title, paper.authors, year].filter(Boolean).join(' — '),
    url: paper.url,
    snippet: paper.abstract.replace(/\s+/g, ' ').trim().slice(0, 240),
  };
}

export const alphaxivConnector: Connector = {
  id: 'alphaxiv',
  label: 'alphaXiv',
  // Advertised only once connected, like the calendar connector
  isAvailable: (env) => env.alphaxivConnected,
  tools: [
    {
      name: 'find_papers',
      loop: 'costly',
      description:
        'Search arXiv for papers on a topic the user has NOT read yet ("find papers on speculative decoding", "what\'s new in diffusion models"). This searches the whole research corpus — use search_library instead for what the user has already read or written.',
      params: {
        type: 'object',
        required: ['topic'],
        additionalProperties: false,
        properties: {
          topic: {
            type: 'string',
            description: 'What the papers should be about, in the user\'s own words',
            maxLength: 300,
          },
          recent: {
            type: 'boolean',
            description: 'True when the user asked for the newest or latest work',
          },
        },
      },
      palette: {
        label: 'Find papers on arXiv',
        keywords: ['papers', 'arxiv', 'research', 'find', 'literature'],
        argPlaceholder: 'a topic',
      },
      summary: (p) => `Search arXiv for papers on “${p.topic as string}”`,
      run: async (p) => {
        const topic = p.topic as string;
        // The server answers with a numbered markdown-ish list. Structure it so
        // the chat can draw cards, and fall back to its own words if the shape
        // it sends ever changes.
        const raw = await ax(
          { type: 'AX_DISCOVER', topic, recent: p.recent as boolean | undefined },
          `alphaXiv found nothing on “${topic}”.`,
        );
        const papers = parseDiscoveredPapers(raw);
        return papers.length
          ? { text: formatDiscoveredPapers(papers, topic), papers, sources: papers.map(paperSource) }
          : raw;
      },
    },
    {
      name: 'read_paper',
      loop: 'costly',
      description:
        'Get the contents of one specific paper by arXiv id, URL, or exact title, so you can summarize or explain it. Use ask_paper instead when the user has a specific question about it.',
      params: {
        type: 'object',
        required: ['paper'],
        additionalProperties: false,
        properties: {
          paper: {
            type: 'string',
            description: 'An arXiv id, a paper URL, or the paper title',
            maxLength: 300,
          },
        },
      },
      summary: (p) => `Read “${p.paper as string}” on alphaXiv`,
      run: async (p) => {
        const paper = p.paper as string;
        const text = await ax(
          { type: 'AX_PAPER_CONTENT', paper },
          'alphaXiv has no readable content for that paper.',
        );
        return { text, sources: refSource(paper) };
      },
    },
    {
      name: 'ask_paper',
      loop: 'costly',
      description:
        'Answer a specific question about one paper, quoting the pages it came from ("what datasets did the RETRO paper use?", "what are the limitations in 2307.12307?").',
      params: {
        type: 'object',
        required: ['paper', 'question'],
        additionalProperties: false,
        properties: {
          paper: {
            type: 'string',
            description: 'An arXiv id, a paper URL, or the paper title',
            maxLength: 300,
          },
          question: {
            type: 'string',
            description: 'What to look for in the paper',
            maxLength: 300,
          },
        },
      },
      summary: (p) => `Ask alphaXiv about “${p.paper as string}”`,
      run: async (p) => {
        // The tool retrieves pages rather than composing an answer, and an
        // action result is printed verbatim — so quote the pages, don't dump XML.
        const raw = await ax(
          {
            type: 'AX_ASK_PDF',
            paper: p.paper as string,
            queries: [p.question as string],
          },
          'Nothing in that paper answered the question.',
        );
        const parsed = parsePagesXml(raw);
        const sources = refSource(p.paper as string);
        const text = parsed.pages.length ? formatPageExcerpts(parsed) : raw;
        return sources.length ? { text, sources } : text;
      },
    },
    {
      name: 'save_paper_to_alphaxiv',
      description:
        "Save a paper to the user's alphaXiv 'Want to read' folder. Only for papers found on alphaXiv — use add_paper-style tracking for the local deck.",
      params: {
        type: 'object',
        required: ['paper'],
        additionalProperties: false,
        properties: {
          paper: {
            type: 'string',
            description: 'An arXiv id or paper URL',
            maxLength: 300,
          },
        },
      },
      confirm: true,
      summary: (p) => `Save ${p.paper as string} to alphaXiv's “Want to read”`,
      run: (p) =>
        ax(
          { type: 'AX_SAVE_PAPER', paper: p.paper as string },
          'Saved to your alphaXiv “Want to read” folder.',
        ),
    },
  ],
};
