import { MAX_LINKS_PER_NOTE, MAX_MENTIONS_PER_NOTE, MENTION_MIN_TITLE_CHARS } from './constants';
import type { EdgeReason } from './graphModel';
import { normalizeTitle } from './papers';
import type { GraphNode } from './types';

/**
 * `[[wiki links]]` — the one thing that lets you say "this note is about that
 * paper" in your own words.
 *
 * Everything else in this graph is inferred: a shared deck, a shared host, a
 * topic a model guessed. A link is asserted, which is why it carries full
 * weight, and it is the difference between a map of what you consumed and a map
 * of what you think.
 */

/** A note as the linker sees it — the shape both brain dumps and annotations reduce to. */
export interface LinkableNote {
  id: string;
  /** Everything the user wrote, already decrypted by the caller */
  text: string;
}

const LINK_RE = /\[\[([^\][]+)\]\]/g;

/**
 * The `[[targets]]` in a piece of text. An unclosed `[[` yields nothing rather
 * than swallowing the rest of the note.
 */
export function parseWikiLinks(text: string, cap = MAX_LINKS_PER_NOTE): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  LINK_RE.lastIndex = 0;
  for (let m = LINK_RE.exec(text); m !== null; m = LINK_RE.exec(text)) {
    const target = m[1].trim();
    if (!target) continue;
    const key = normalizeTitle(target);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(target);
    if (out.length === cap) break;
  }
  return out;
}

/**
 * The node a link points at, or null.
 *
 * Exact title first, then a *unique* prefix. Never a best guess: an unresolved
 * link should read as unresolved — Wikipedia's red link — because quietly
 * pointing at the wrong paper is both wrong and invisible, where a dead link
 * at least tells you something is missing.
 */
export function resolveWikiLink(target: string, nodes: readonly GraphNode[]): GraphNode | null {
  const key = normalizeTitle(target);
  if (!key) return null;

  const exact = nodes.filter((n) => normalizeTitle(n.title) === key);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const prefix = nodes.filter((n) => normalizeTitle(n.title).startsWith(key));
  return prefix.length === 1 ? prefix[0] : null;
}

/**
 * Titles long enough to match on, indexed by their normalized form.
 *
 * The length floor is doing critical work. A node titled "Attention" would
 * appear inside nearly every note ever written about machine learning, and the
 * real mentions would be buried under dozens of accidents.
 */
export function mentionIndex(nodes: readonly GraphNode[]): Map<string, GraphNode> {
  const index = new Map<string, GraphNode>();
  for (const node of nodes) {
    const key = normalizeTitle(node.title);
    if (key.length < MENTION_MIN_TITLE_CHARS) continue;
    if (!index.has(key)) index.set(key, node);
  }
  return index;
}

/**
 * Nodes a note names without linking — the connections you made and did not
 * notice making. Most specific first, so the cap keeps the best ones.
 *
 * A pair that is already linked never also appears as a mention: linking
 * something has to make the graph tidier, not add a second relationship
 * alongside the one you just created.
 */
export function unlinkedMentions(
  note: LinkableNote,
  index: ReadonlyMap<string, GraphNode>,
  linked: ReadonlySet<string>,
  cap = MAX_MENTIONS_PER_NOTE,
): GraphNode[] {
  const haystack = normalizeTitle(note.text);
  if (!haystack) return [];

  const hits: GraphNode[] = [];
  for (const [key, node] of index) {
    if (linked.has(node.id)) continue;
    if (!haystack.includes(key)) continue;
    hits.push(node);
  }
  return hits
    .sort((a, b) => normalizeTitle(b.title).length - normalizeTitle(a.title).length)
    .slice(0, cap);
}

/**
 * Wrap the first occurrence of a title in `[[…]]`, so "Connect" turns a mention
 * into a real link. Returns the text unchanged when the title is not actually
 * there, which is what makes the button safe to press twice.
 */
export function linkMention(text: string, title: string): string {
  const at = text.toLowerCase().indexOf(title.toLowerCase());
  if (at < 0) return text;
  return `${text.slice(0, at)}[[${text.slice(at, at + title.length)}]]${text.slice(at + title.length)}`;
}

/** Edges a note's links and mentions imply, for structuralEdges to fold in. */
export function noteEdges(
  notes: readonly LinkableNote[],
  nodes: readonly GraphNode[],
  add: (a: string, b: string, reason: EdgeReason) => void,
): void {
  const index = mentionIndex(nodes);

  for (const note of notes) {
    const linked = new Set<string>();
    for (const target of parseWikiLinks(note.text)) {
      const hit = resolveWikiLink(target, nodes);
      if (!hit) continue; // a red link: real, and pointing at nothing yet
      linked.add(hit.id);
      add(note.id, hit.id, 'link');
    }
    for (const node of unlinkedMentions(note, index, linked)) {
      add(note.id, node.id, 'mention');
    }
  }
}
