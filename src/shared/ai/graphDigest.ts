import type { VisibleGraph, VisibleNode } from '../graphView';
import type { GraphNodeKind } from '../types';
import type { SourceRef } from './connectors/base';

/**
 * What is on the graph right now, and how to describe it.
 *
 * The page publishes this; the assistant reads it. That direction matters:
 * "what is on screen" is precisely what storage does not know, because the
 * render cap, the kind chips and the topic filter are all view state. A tool
 * that recomputed from `graphNodes` would answer a different question —
 * confidently, and wrongly.
 *
 * Everything here is structured rather than prose. `explain_cluster` returns
 * facts and lets the model that called it write the sentence, which is the same
 * design as `search_library`: no extra model call, nothing to fabricate, and
 * the answer lands in whichever chat asked.
 */

export type { VisibleGraph, VisibleNode } from '../graphView';
export { EMPTY_VISIBLE } from '../graphView';

/** Finished, by the same threshold the completion ring uses. */
const READ = 0.9;
/** Topics named before the description starts counting the rest. */
const NAMED_TOPICS = 6;
/** Citation pairs quoted; past this it is a list, not an observation. */
const NAMED_CITES = 8;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Nodes grouped by each topic they carry, largest group first. */
export function groupByTopic(nodes: readonly VisibleNode[]): [string, VisibleNode[]][] {
  const groups = new Map<string, VisibleNode[]>();
  for (const node of nodes) {
    for (const topic of new Set(node.topics)) {
      const list = groups.get(topic);
      if (list) list.push(node);
      else groups.set(topic, [node]);
    }
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

/**
 * The facts about what is on screen, as text for a model to compose from.
 *
 * Deliberately not an answer: every line is countable from the digest, so the
 * assistant can only report what is actually there. A topic where nothing has
 * been read is called out by name because that is the observation a reader
 * wants and would otherwise have to derive by eye.
 */
export function describeVisible(visible: VisibleGraph): string {
  const { nodes } = visible;
  if (nodes.length === 0) {
    return visible.topic
      ? `Nothing is showing under “${visible.topic}”.`
      : 'The graph is showing nothing at the moment.';
  }

  const lines: string[] = [];
  const scope = visible.topic ? ` under “${visible.topic}”` : '';
  const readCount = nodes.filter((n) => n.read >= READ).length;
  lines.push(
    visible.mode === 'lineage'
      ? `${plural(nodes.length, 'thing')} in this citation lineage${scope}; ${readCount} finished, ${nodes.length - readCount} not.`
      : `${plural(nodes.length, 'thing')} on the graph${scope}; ${readCount} finished, ${nodes.length - readCount} not.`,
  );

  const selected = nodes.find((n) => n.id === visible.selectedId);
  if (selected) lines.push(`Selected: ${selected.title}.`);

  const groups = groupByTopic(nodes);
  if (groups.length) {
    lines.push('', 'By topic:');
    for (const [topic, members] of groups.slice(0, NAMED_TOPICS)) {
      const done = members.filter((n) => n.read >= READ).length;
      lines.push(`- ${topic}: ${plural(members.length, 'thing')}, ${done} finished`);
    }
    const rest = groups.length - NAMED_TOPICS;
    if (rest > 0) lines.push(`- and ${plural(rest, 'more topic')}`);
  }

  // The gap worth naming: a subject entirely untouched.
  const untouched = groups
    .filter(([, members]) => members.every((n) => n.read < READ))
    .map(([topic]) => topic);
  if (untouched.length) {
    lines.push('', `Nothing finished yet in: ${untouched.slice(0, NAMED_TOPICS).join(', ')}.`);
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pairs = visible.cites
    .map(([from, to]) => [byId.get(from), byId.get(to)] as const)
    .filter((p): p is [VisibleNode, VisibleNode] => Boolean(p[0] && p[1]));
  if (pairs.length) {
    lines.push('', 'Citations between things on screen:');
    for (const [from, to] of pairs.slice(0, NAMED_CITES)) {
      lines.push(`- ${from.title} → ${to.title}`);
    }
    const more = pairs.length - NAMED_CITES;
    if (more > 0) lines.push(`- and ${plural(more, 'more')}`);
  }

  const unconnected = nodes.filter((n) => n.topics.length === 0).length;
  if (unconnected) {
    lines.push('', `${plural(unconnected, 'thing has', 'things have')} no topic yet.`);
  }

  return lines.join('\n');
}

const SOURCE_KIND: Record<GraphNodeKind, SourceRef['kind']> = {
  paper: 'paper',
  external: 'paper',
  note: 'note',
  highlight: 'highlight',
  recording: 'recording',
  article: 'page',
  video: 'page',
  bookmark: 'page',
};

/**
 * Citable sources, minted from the digest rather than parsed out of prose —
 * so a cited item is always something that was genuinely on screen.
 */
export function visibleSources(visible: VisibleGraph, max = 8): SourceRef[] {
  return visible.nodes
    .filter((n) => n.url)
    .slice(0, max)
    .map((n) => ({ id: '', kind: SOURCE_KIND[n.kind], title: n.title, url: n.url }));
}
