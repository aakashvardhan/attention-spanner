import { GRAPH_TOPIC_MENU_MAX, GRAPH_VISIBLE_STALE_MS } from '../../constants';
import { sendMessage } from '../../messages';
import { getLocal, getSession, setSession } from '../../storage';
import type { GraphNodeKind } from '../../types';
import { isGraphOpen, nextView, resolveTopic } from '../../graphView';
import { describeVisible, visibleSources } from '../graphDigest';
import { buildVocabulary } from '../topics';
import { resolveByText, type Connector } from './base';

/**
 * Steering and reading the knowledge graph.
 *
 * `focus_graph` is `loop: 'auto'`, and the reasoning belongs in the file rather
 * than a commit message: it writes one session key that a single extension page
 * reads to decide what it draws. It spawns nothing, navigates nowhere, mutates
 * no user data and reads nothing back. That makes it strictly less capable than
 * `search_library`, which is already `'auto'` and pulls the text of highlights
 * and notes into a model's context. `open_page` is `'stage'` because a *tab* is
 * a navigation an injected page could aim; changing which of your own nodes are
 * highlighted is not the same act.
 *
 * The hard rule that keeps that true: nothing here ever opens the graph page.
 * The single navigation capability stays in the single `'stage'` tool that
 * already has it, rather than being smuggled in behind an `'auto'` annotation.
 */

const KINDS: GraphNodeKind[] = [
  'article',
  'video',
  'paper',
  'bookmark',
  'recording',
  'external',
  'note',
  'highlight',
];

/** Every write bumps the nonce, so applying the same filter twice still fires. */
async function writeView(patch: {
  topic?: string;
  focusId?: string;
  hiddenKinds?: GraphNodeKind[];
}): Promise<void> {
  const { graphView } = await getSession('graphView');
  await setSession({ graphView: nextView(graphView, patch) });
}

/** Whether a graph page is currently showing anything. */
async function graphIsOpen(): Promise<boolean> {
  const { graphVisible } = await getSession('graphVisible');
  return isGraphOpen(graphVisible, Date.now(), GRAPH_VISIBLE_STALE_MS);
}

const OPEN_HINT = 'The graph page is not open — open it and this will already be applied.';

export const graphConnector: Connector = {
  id: 'graph',
  label: 'Knowledge graph',
  isAvailable: () => true,
  tools: [
    {
      name: 'focus_graph',
      loop: 'auto',
      description:
        'Narrow the knowledge graph to one topic, or centre it on one thing ("show me just the RLHF stuff", "focus on the attention paper", "show everything again"). Only changes what the graph page displays.',
      params: {
        type: 'object',
        required: [],
        additionalProperties: false,
        properties: {
          topic: {
            type: 'string',
            description: 'Show only things about this topic',
            maxLength: 60,
          },
          node: {
            type: 'string',
            description: 'Title of one thing to select and centre on',
            maxLength: 200,
          },
          clear: {
            type: 'boolean',
            description: 'True to show everything again',
          },
        },
      },
      palette: {
        label: 'Focus the graph',
        keywords: ['graph', 'focus', 'topic', 'map', 'show'],
        argPlaceholder: 'a topic',
      },
      summary: (p) =>
        p.clear
          ? 'Show the whole graph again'
          : p.node
            ? `Centre the graph on “${p.node as string}”`
            : `Show only “${p.topic as string}” on the graph`,
      run: async (p) => {
        if (p.clear) {
          await writeView({ topic: '', hiddenKinds: [] });
          return 'Showing the whole graph again.';
        }

        const { graphNodes } = await getLocal('graphNodes');

        if (p.node) {
          // The model names a title; ids never leave this file.
          const hit = resolveByText(graphNodes, (n) => n.title, p.node as string);
          if (hit.kind === 'none') return `Nothing on the graph matches “${p.node as string}”.`;
          if (hit.kind === 'ambiguous') {
            return `Did you mean: ${hit.candidates.map((c) => c.title).join('; ')}?`;
          }
          await writeView({ focusId: hit.item.id });
          const open = await graphIsOpen();
          return `Centred the graph on “${hit.item.title}”.${open ? '' : ` ${OPEN_HINT}`}`;
        }

        const topic = (p.topic as string | undefined)?.trim().toLowerCase() ?? '';
        if (!topic) return 'Say a topic to focus on, or ask to see everything again.';

        const topics = buildVocabulary(graphNodes, GRAPH_TOPIC_MENU_MAX);
        const match = resolveTopic(topic, topics);
        // Blanking the page because the model invented a topic is the failure
        // to avoid: say what is actually there instead.
        if (!match) {
          return topics.length
            ? `There is no “${topic}” on the graph. Topics in use: ${topics.slice(0, 12).join(', ')}.`
            : 'Nothing on the graph has topics yet — press “Sort into topics” on the graph page first.';
        }

        await writeView({ topic: match });
        const open = await graphIsOpen();
        return `Showing only “${match}”.${open ? '' : ` ${OPEN_HINT}`}`;
      },
    },

    {
      name: 'explain_cluster',
      loop: 'auto',
      description:
        "Report what is currently on the knowledge graph — how it groups by topic, how much of each the user has finished, what is untouched, and which papers on screen cite each other. Use for “what's in this cluster”, “what am I missing here”, “what is this part of the graph about”.",
      params: {
        type: 'object',
        required: [],
        additionalProperties: false,
        properties: {},
      },
      palette: {
        label: 'Explain what the graph is showing',
        keywords: ['graph', 'cluster', 'explain', 'missing', 'gap'],
      },
      summary: () => 'Look at what the graph is showing',
      run: async () => {
        const { graphVisible } = await getSession('graphVisible');
        // Honest failure. Describing a view nobody is looking at — confidently,
        // from a different question's data — is the outcome worth preventing.
        if (!isGraphOpen(graphVisible, Date.now(), GRAPH_VISIBLE_STALE_MS)) {
          return 'The graph page is not open, so there is nothing on screen to describe.';
        }
        return {
          text: describeVisible(graphVisible),
          sources: visibleSources(graphVisible),
        };
      },
    },

    {
      name: 'expand_citations',
      // A network read that fills a cache, exactly like find_papers. No confirm:
      // it mutates nothing the user would have to undo.
      loop: 'costly',
      description:
        'Look up what one tracked paper cites and what cites it, and add those to the knowledge graph ("what does the attention paper cite", "show me what builds on DDPM").',
      params: {
        type: 'object',
        required: ['paper'],
        additionalProperties: false,
        properties: {
          paper: {
            type: 'string',
            description: 'Title of a paper already in the library',
            maxLength: 200,
          },
        },
      },
      summary: (p) => `Look up the citations for “${p.paper as string}”`,
      run: async (p) => {
        const { papers } = await getLocal('papers');
        const hit = resolveByText(papers, (item) => item.title, p.paper as string);
        if (hit.kind === 'none') return `“${p.paper as string}” is not in your papers.`;
        // Never spend a rate-limited request on a guess.
        if (hit.kind === 'ambiguous') {
          return `Did you mean: ${hit.candidates.map((c) => c.title).join('; ')}?`;
        }

        const res = await sendMessage({ type: 'GRAPH_EXPAND_CITATIONS', paperId: hit.item.id });
        if (!res.ok) return res.error ?? 'Could not look that paper up.';
        const note = res.note ? ` ${res.note}` : '';
        return `Added ${res.added ?? 0} related papers around “${hit.item.title}”.${note}`;
      },
    },
  ],
};

/** Exported for the graph page's own use, so both write the view identically. */
export { KINDS as GRAPH_KINDS };
