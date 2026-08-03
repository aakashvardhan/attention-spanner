import type { Reference } from './bibliography';
import type { CitationExpansion, ExternalPaper } from './citations';
import { paperMatchKey } from './papers';

/**
 * What a paper builds on, grouped by subject.
 *
 * The question this answers is "where did the ideas in this paper come from",
 * which a force-directed map cannot show: a blob of dots has no reading order
 * and no headings. A list grouped by subject and ordered by year does — read it
 * top to bottom and you are reading the order the ideas arrived in.
 *
 * Two sources, neither sufficient alone. The document's own bibliography is
 * complete and authoritative but is raw citation strings; the citation
 * expansion has real metadata but only covers what a remote index returned. So
 * the bibliography is the spine and the expansion enriches it, joined on the
 * match key both already carry. Nothing is ever dropped for lacking a topic.
 */

/** Where an entry sits when nothing gave it a subject. */
export const UNGROUPED = 'everything else';

export interface LineageEntry {
  /** Match key when there is one, else a positional fallback */
  id: string;
  /** The paper's title when a source knew it; the raw citation string otherwise */
  title: string;
  year: number | null;
  /** Set when this is already in the library — the row then opens inward */
  ownedKey: string | null;
  /** Where to open it when it is not owned; '' when the entry had no link */
  externalUrl: string;
  /** How many papers cite it; null when unknown */
  citations: number | null;
  /** True when only the bibliography knew about it */
  fromDocumentOnly: boolean;
  /**
   * The citation index's own id, when it had one. The graph turns this into a
   * node id (`ext:…`); this module deliberately does not, so it stays free of
   * the graph's id scheme.
   */
  sourceId: string | null;
}

export interface LineageGroup {
  topic: string;
  entries: LineageEntry[];
}

/** How long a raw citation string may run before it stops being a title. */
const RAW_TITLE_CHARS = 110;

function shorten(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > RAW_TITLE_CHARS ? `${clean.slice(0, RAW_TITLE_CHARS).trimEnd()}…` : clean;
}

function entryFrom(
  ref: Reference | null,
  paper: ExternalPaper | null,
  index: number,
  owned: ReadonlySet<string>,
): LineageEntry {
  const key = paper?.matchKey ?? (ref?.link ? paperMatchKey(ref.link) : null);
  return {
    id: key ?? `ref-${index}`,
    // A source's title beats the raw string — "Denoising Diffusion
    // Probabilistic Models" against "Ho, J., Jain, A., Abbeel, P. Denoising…".
    title: paper?.title ? shorten(paper.title) : shorten(ref?.text ?? ''),
    year: paper?.year ?? ref?.year ?? null,
    ownedKey: key && owned.has(key) ? key : null,
    externalUrl: paper?.url ?? ref?.link ?? '',
    citations: paper?.citations ?? null,
    fromDocumentOnly: paper === null,
    sourceId: paper?.s2Id ?? null,
  };
}

/**
 * The subject a reference is filed under. Index 0 of the source's topics: that
 * is the coarser of the hierarchy it returns, and the level at which forty
 * references become six headings rather than thirty.
 */
function topicOf(paper: ExternalPaper | null): string {
  return paper?.topics[0] ?? UNGROUPED;
}

/**
 * Group what this paper builds on.
 *
 * `owned` is the set of match keys already in the library — passed in rather
 * than resolved here so this stays pure and the caller keeps the one index it
 * already builds for the citation markers.
 */
export function buildLineage(
  refs: readonly Reference[],
  expansion: CitationExpansion | null,
  owned: ReadonlySet<string>,
): LineageGroup[] {
  const references = (expansion?.papers ?? []).filter((p) => p.relation === 'reference');
  const byKey = new Map<string, ExternalPaper>();
  for (const paper of references) if (paper.matchKey) byKey.set(paper.matchKey, paper);

  const filed: { topic: string; entry: LineageEntry }[] = [];
  const used = new Set<string>();

  // The document's own list first, in its own order.
  refs.forEach((ref, i) => {
    const key = ref.link ? paperMatchKey(ref.link) : null;
    const paper = key ? (byKey.get(key) ?? null) : null;
    if (key) used.add(key);
    filed.push({ topic: topicOf(paper), entry: entryFrom(ref, paper, i, owned) });
  });

  // Then anything the index knew about that the bibliography parser missed —
  // a mis-split entry, or a reference with no extractable link.
  references.forEach((paper, i) => {
    if (paper.matchKey && used.has(paper.matchKey)) return;
    filed.push({ topic: topicOf(paper), entry: entryFrom(null, paper, refs.length + i, owned) });
  });

  const groups = new Map<string, LineageEntry[]>();
  for (const { topic, entry } of filed) {
    const list = groups.get(topic);
    if (list) list.push(entry);
    else groups.set(topic, [entry]);
  }

  return [...groups.entries()]
    .map(([topic, list]) => ({
      topic,
      // Oldest first: the reading order is the argument this view makes.
      // Undated entries sink, since they cannot take part in it.
      entries: list.sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity)),
    }))
    .sort((a, b) => {
      // A leftovers bin is not a subject, so it never leads however big it is.
      if (a.topic === UNGROUPED) return 1;
      if (b.topic === UNGROUPED) return -1;
      return b.entries.length - a.entries.length || a.topic.localeCompare(b.topic);
    });
}

/* ---- Lineage by year --------------------------------------------------- */

/** Horizontal distance between one publication year and the next. */
const YEAR_GAP = 150;
/** Vertical step between two works published the same year. */
const YEAR_ROW_GAP = 52;
/** Where undated works are parked, in years to the left of the oldest. */
const UNDATED_OFFSET = 2;

export interface DatedNode {
  id: string;
  /** Publication year; null when no source knew one */
  year: number | null;
}

/**
 * Where each node sits when the horizontal axis is time.
 *
 * The point of a layered layout is that lineage reads left to right without a
 * legend: everything a paper builds on is behind it, everything building on it
 * is ahead. A force layout cannot express that, because it has no idea which of
 * two connected nodes came first — the arrowheads say so, but only once you are
 * close enough to see them.
 *
 * These are `pinned` positions, not `home` targets, and that distinction was
 * learned the hard way: a citation spring pulls roughly a hundred times harder
 * than the home force can answer at column distance, so an arrangement
 * expressed as targets alone collapses into a ring around the centre.
 *
 * Undated works are parked in a gutter to the left rather than interleaved.
 * Guessing a year would put them somewhere specific and wrong, and a column
 * that means "we do not know" is honest in a way a guess is not.
 */
export function yearHomes(nodes: readonly DatedNode[]): Map<string, { x: number; y: number }> {
  const homes = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return homes;

  const years = nodes.map((n) => n.year).filter((y): y is number => y !== null);
  // Everything undated is one column; there is no axis to hang it on.
  const oldest = years.length ? Math.min(...years) : 0;
  const columnFor = (year: number | null) => (year === null ? -UNDATED_OFFSET : year - oldest);

  // Group first so a column can be centred on the axis rather than growing down
  // from it — otherwise a busy year drags the whole map below the centre line.
  const byColumn = new Map<number, string[]>();
  for (const n of nodes) {
    const column = columnFor(n.year);
    const list = byColumn.get(column);
    if (list) list.push(n.id);
    else byColumn.set(column, [n.id]);
  }

  for (const [column, ids] of byColumn) {
    const offset = ((ids.length - 1) * YEAR_ROW_GAP) / 2;
    ids.forEach((id, i) => {
      homes.set(id, { x: column * YEAR_GAP, y: i * YEAR_ROW_GAP - offset });
    });
  }

  // Centre the whole thing horizontally, so the graph opens on its own middle
  // rather than with the oldest work pinned to the origin.
  const columns = [...byColumn.keys()];
  const shift = ((Math.min(...columns) + Math.max(...columns)) / 2) * YEAR_GAP;
  for (const home of homes.values()) home.x -= shift;

  return homes;
}

/** Every entry across the groups — for counts, and for "how many are mine". */
export function lineageStats(groups: readonly LineageGroup[]): {
  total: number;
  owned: number;
  untopiced: number;
} {
  const all = groups.flatMap((g) => g.entries);
  return {
    total: all.length,
    owned: all.filter((e) => e.ownedKey !== null).length,
    untopiced: groups.find((g) => g.topic === UNGROUPED)?.entries.length ?? 0,
  };
}
