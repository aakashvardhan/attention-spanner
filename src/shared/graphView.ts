import type { GraphNodeKind } from './types';

/**
 * What the graph page is showing, and what it is showing it *from*.
 *
 * Two shapes with opposite directions. `GraphView` is a control: the toolbar
 * and the assistant both write it, the page reads it. `VisibleGraph` is a
 * report: the page writes it, the assistant reads it. Keeping the control and
 * the report separate is what stops a tool from steering by describing.
 *
 * Both live in session storage rather than local: a view filter belongs to this
 * sitting, and opening the graph tomorrow under yesterday's topic would be its
 * own small bug.
 */

export interface GraphView {
  /** Topic to isolate; '' = everything */
  topic: string;
  /** Node to select and centre; consumed once per `nonce` */
  focusId: string;
  hiddenKinds: GraphNodeKind[];
  /**
   * Show one paper's citation lineage instead of the whole map; '' = the whole
   * map. Unlike `focusId` this is a mode, not a one-shot — it persists until
   * cleared, because it is what the page is *for* while it is set.
   */
  lineageOf: string;
  /** Bumped on every write, so re-applying an identical filter still fires */
  nonce: number;
}

export const EMPTY_VIEW: GraphView = {
  topic: '',
  focusId: '',
  hiddenKinds: [],
  lineageOf: '',
  nonce: 0,
};

export interface VisibleNode {
  id: string;
  title: string;
  kind: GraphNodeKind;
  url: string;
  topics: string[];
  /** 0–1, how much of it was consumed */
  read: number;
}

export interface VisibleGraph {
  nodes: VisibleNode[];
  /** Citation pairs among the visible nodes, as [citing, cited] ids */
  cites: [string, string][];
  selectedId: string;
  /** The topic filter in force; '' = everything */
  topic: string;
  /** The page can show either relationships or a paper's citation lineage. */
  mode?: 'map' | 'lineage';
  /** 0 = the graph page has never been open in this session */
  updatedAt: number;
  /** Which mount published this, so only that mount clears it on unmount */
  publisherId: string;
}

export const EMPTY_VISIBLE: VisibleGraph = {
  nodes: [],
  cites: [],
  selectedId: '',
  topic: '',
  mode: 'map',
  updatedAt: 0,
  publisherId: '',
};

/**
 * Is a graph page actually showing this?
 *
 * Freshness rather than a farewell message. Clearing the digest when the page
 * unmounts sounds right and does not work: navigating away tears the document
 * down without waiting for React cleanup, and the storage write it would issue
 * never lands — so the assistant would go on describing a screen that closed
 * minutes ago. The page instead reports that it is still there, on a heartbeat,
 * and silence is what means gone.
 */
export function isGraphOpen(visible: VisibleGraph, now: number, staleMs: number): boolean {
  return visible.updatedAt > 0 && now - visible.updatedAt < staleMs;
}

/**
 * The next view state.
 *
 * The nonce is load-bearing, not bookkeeping. `chrome.storage` fires no change
 * event when the written value is byte-identical, so asking twice for the same
 * topic would leave the second request looking like it did nothing at all —
 * and a focus command re-applied on a later, unrelated write would re-select a
 * node the user had just dismissed. Bumping every time makes each write an
 * event, and `focusId` clearing makes it a one-shot.
 */
export function nextView(current: GraphView, patch: Partial<GraphView>): GraphView {
  return {
    topic: patch.topic ?? current.topic,
    hiddenKinds: patch.hiddenKinds ?? current.hiddenKinds,
    lineageOf: patch.lineageOf ?? current.lineageOf,
    focusId: patch.focusId ?? '',
    nonce: current.nonce + 1,
  };
}

/**
 * Which topic in use a request means, or null.
 *
 * Exact first, then a containment match so "diffusion" finds "diffusion
 * models". Returning null rather than a near-miss matters: a model that invents
 * a topic would otherwise blank the page, and the user would be looking at an
 * empty graph with nothing saying why.
 */
export function resolveTopic(query: string, topics: readonly string[]): string | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return topics.find((t) => t === q) ?? topics.find((t) => t.includes(q)) ?? null;
}
