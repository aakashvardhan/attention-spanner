import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildVocabulary, enrichTopics, needsTags } from '../../shared/ai/topics';
import { nextView, type VisibleGraph } from '../../shared/graphView';
import {
  GRAPH_DIGEST_MAX_NODES,
  GRAPH_TOPIC_MENU_MAX,
  GRAPH_VISIBLE_HEARTBEAT_MS,
  NEWTAB_PAGE_PATH,
} from '../../shared/constants';
import {
  externalNodeId,
  liveExternals,
  nodesFromExternals,
  readingQueue,
} from '../../shared/citations';
import { yearHomes } from '../../shared/citationLineage';
import { ephemeralNodes } from '../../shared/graphNodes';
import { useNotes } from '../../shared/hooks/useNotes';
import { useNotesLock } from '../../shared/hooks/useNotesLock';
import {
  mentionIndex,
  parseWikiLinks,
  resolveWikiLink,
  unlinkedMentions,
  type LinkableNote,
} from '../../shared/wikilink';
import type { Annotation, BrainDumpNote } from '../../shared/types';
import { buildGraph, type RenderNode } from '../../shared/graphModel';
import { paperMatchKey } from '../../shared/papers';
import { useSessionValue } from '../../shared/hooks/useSessionValue';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { setSession } from '../../shared/storage';
import { useTheme } from '../../shared/hooks/useTheme';
import { sendMessage } from '../../shared/messages';
import { recordingReaderUrl } from '../../shared/pdf';
import { GraphCanvas, type ConnectionMode } from './components/GraphCanvas';
import { GraphAsk } from './components/GraphAsk';
import { NodeInspector } from './components/NodeInspector';

/** Kept in step with `.gr-inspector`'s width in graph.css. */
const INSPECTOR_WIDTH = 320;
/** `.gr-ask`'s max height, for the same reason. */
const ASK_HEIGHT = 460;

/** `label` names the filter (plural, a set); `legend` names one node. */
const KINDS = [
  { id: 'article', label: 'Articles', legend: 'article' },
  { id: 'video', label: 'Videos', legend: 'video' },
  { id: 'paper', label: 'Papers', legend: 'paper' },
  { id: 'bookmark', label: 'Bookmarks', legend: 'bookmark' },
  { id: 'recording', label: 'Recordings', legend: 'recording' },
  { id: 'external', label: 'Not saved yet', legend: 'cited, not saved' },
  { id: 'note', label: 'Notes', legend: 'note' },
  { id: 'highlight', label: 'Highlights', legend: 'highlight' },
] as const;

type Kind = (typeof KINDS)[number]['id'];

/** A note's opening words, so a mention row says which note it is. */
function noteLabel(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 70 ? `${clean.slice(0, 70).trimEnd()}…` : clean;
}

/**
 * What the linker reads. A sealed vault contributes nothing: the text is what
 * `[[links]]` are parsed out of, so passing it while locked would leak exactly
 * what the passcode exists to hide.
 */
function linkableNotes(
  notes: BrainDumpNote[],
  annotations: Annotation[],
  locked: boolean,
): LinkableNote[] {
  const out: LinkableNote[] = [];
  if (!locked) {
    for (const n of notes) {
      out.push({ id: `note:${n.id}`, text: [n.rawText, ...n.bullets].join('\n') });
    }
  }
  for (const a of annotations) {
    if (a.note) out.push({ id: `hl:${a.id}`, text: a.note });
  }
  return out;
}

export function Graph() {
  const theme = useTheme();
  const [graphNodes, nodesLoaded] = useStorageValue('graphNodes');
  const [papers] = useStorageValue('papers');
  const [bookmarks] = useStorageValue('bookmarks');
  const [recordings] = useStorageValue('recordings');
  const [annotations] = useStorageValue('annotations');
  const [graphCitations] = useStorageValue('graphCitations');

  // Your own writing. `useNotes` hands back plaintext only when the vault is
  // unlocked; while locked the sealed notes are simply absent, and
  // `ephemeralNodes` emits none — the graph must never publish what the
  // passcode is hiding.
  const { privateKey, locked } = useNotesLock();
  const { notes } = useNotes(privateKey);

  // The view lives in session storage rather than component state, because the
  // assistant writes it too. One source of truth beats tool state merged over
  // React state, which is where designs like this rot. `selected` stays local:
  // it changes constantly and nothing outside needs it.
  const [view] = useSessionValue('graphView');
  const viewRef = useRef(view);
  viewRef.current = view;

  const hidden = useMemo(() => new Set<Kind>(view.hiddenKinds as Kind[]), [view.hiddenKinds]);
  const topic = view.topic;

  const setGraphView = useCallback(
    (patch: { topic?: string; hiddenKinds?: Kind[]; focusId?: string; lineageOf?: string }) => {
      // The same helper the assistant's focus_graph uses, so the two writers
      // can never disagree about what a view update means.
      void setSession({ graphView: nextView(viewRef.current, patch) });
    },
    [],
  );
  const setTopic = useCallback((next: string) => setGraphView({ topic: next }), [setGraphView]);

  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Lifted out of GraphAsk so the canvas can keep the fit clear of it — an
  // open panel is 340px of the bottom-left corner.
  const [askOpen, setAskOpen] = useState(false);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [frameNonce, setFrameNonce] = useState(0);
  const [focusFrameNonce, setFocusFrameNonce] = useState(0);
  const filtersRef = useRef<HTMLDetailsElement>(null);
  // One relationship question at a time. Citations and recording mentions are
  // always evidence; this controls the additional context layer.
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('evidence');
  const [surface, setSurface] = useState<'map' | 'inbox'>('map');
  const [sorting, setSorting] = useState<{ done: number; total: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Focus is edge-triggered on the nonce, so the user can deselect afterwards
  // without the last tool call immediately re-selecting for them.
  const seenNonce = useRef(view.nonce);
  useEffect(() => {
    if (view.nonce === seenNonce.current) return;
    seenNonce.current = view.nonce;
    if (view.focusId) {
      setSelected(view.focusId);
      setFocusFrameNonce((n) => n + 1);
    }
  }, [view.nonce, view.focusId]);

  const unlabelled = useMemo(() => graphNodes.filter(needsTags).length, [graphNodes]);
  const topics = useMemo(
    () => buildVocabulary(graphNodes, GRAPH_TOPIC_MENU_MAX),
    [graphNodes],
  );

  // A topic that no longer exists — the last thing carrying it was deleted, or
  // a re-sort renamed it — would filter the graph down to nothing with no way
  // to tell why. Fall back to showing everything.
  useEffect(() => {
    if (topic && !topics.includes(topic)) setTopic('');
  }, [topic, topics]);

  async function sortIntoTopics() {
    setSorting({ done: 0, total: unlabelled });
    try {
      await enrichTopics(graphNodes, { onProgress: setSorting });
    } finally {
      setSorting(null);
    }
  }

  // Rebuild the nodes that mirror durable records. Papers and bookmarks can
  // arrive via cloud sync without ever passing through a handler here, so the
  // reconcile is what makes those appear at all.
  useEffect(() => {
    void sendMessage({ type: 'GRAPH_SYNC' });
  }, []);

  const model = useMemo(() => {
    const now = Date.now();
    // Borrowed papers are filtered before projection: an expansion whose parent
    // is gone, or an external the user has since added, must never become a node.
    const citations = liveExternals(graphCitations, papers);

    // paperMatchKey → node id, so a citation of something already tracked
    // resolves inward to that paper instead of drawing a duplicate beside it.
    const paperNodeByKey = new Map<string, string>();
    for (const p of papers) {
      for (const url of [p.url, p.pdf?.url]) {
        const key = url ? paperMatchKey(url) : null;
        if (key) paperNodeByKey.set(key, `paper:${p.id}`);
      }
    }

    // Built after the index, and given it: an expansion entry naming a paper
    // the user owns must not become a second node, but its edge still lands on
    // the paper they have.
    const borrowed = hidden.has('external')
      ? []
      : nodesFromExternals(citations, now, new Set(paperNodeByKey.keys()));

    // Notes and highlights are projected here and never stored — see
    // ephemeralNodes for why that is a rule rather than an optimisation.
    const writing = ephemeralNodes({ notes, annotations, locked });

    const visible = [...graphNodes, ...borrowed, ...writing].filter(
      (n) =>
        !hidden.has(n.kind) &&
        // A topic filter is about the user's own reading; borrowed papers carry
        // no topics, so filtering them out is what the filter means.
        (!topic || n.tags.includes(topic)),
    );

    return buildGraph(
      visible,
      {
        paperIds: new Set(papers.map((p) => p.id)),
        bookmarkIds: new Set(bookmarks.map((b) => b.id)),
        recordings,
        annotations,
        citations,
        paperNodeByKey,
        notes: linkableNotes(notes, annotations, locked),
      },
      { now },
    );
  }, [
    graphNodes,
    graphCitations,
    papers,
    bookmarks,
    recordings,
    annotations,
    notes,
    locked,
    hidden,
    topic,
  ]);

  // A node can vanish while selected — a paper deleted in another tab, or a
  // kind filter switched off. Clear rather than leaving a dangling inspector.
  const selectedNode = model.nodes.find((n) => n.id === selected) ?? null;
  useEffect(() => {
    if (selected !== null && !selectedNode) setSelected(null);
  }, [selected, selectedNode]);

  /** Nothing in the library at all — distinct from nothing being connected. */
  const isEmpty = nodesLoaded && model.nodes.length === 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null);
      if (e.key === '/' && e.target !== searchRef.current) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function openNode(node: RenderNode) {
    const url = node.kind === 'recording' ? recordingReaderUrl(node.id.slice('recording:'.length)) : node.url;
    if (!url) return;
    void chrome.tabs.create({ url });
  }

  function toggleKind(kind: Kind) {
    const next = new Set(hidden);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    setGraphView({ hiddenKinds: [...next] });
  }

  /**
   * Lineage mode: one paper's citation ancestry, laid out in columns instead of
   * neighbourhoods. Narrowed to the paper and what it cites, because the point
   * of the view is provenance — a deck-mate or a same-site article is noise
   * here however related it is otherwise.
   */
  const lineage = useMemo(() => {
    const centre = view.lineageOf;
    if (!centre || !centre.startsWith('paper:')) return null;
    const expansion = graphCitations[centre.slice('paper:'.length)] ?? null;
    if (!expansion) return null;

    // matchKey → the node id of a paper already tracked, so a cited paper the
    // user owns lands on their own node rather than a borrowed duplicate.
    const ownedNode = new Map<string, string>();
    for (const p of papers) {
      for (const url of [p.url, p.pdf?.url]) {
        const key = url ? paperMatchKey(url) : null;
        if (key) ownedNode.set(key, `paper:${p.id}`);
      }
    }
    // Every work in the lineage, with the year that places it on the axis. A
    // paper the user owns contributes its own year — the citation index and the
    // library agree on the work, not necessarily on the metadata, and the
    // library's is the one they curated.
    const yearOfOwned = new Map(papers.map((p) => [`paper:${p.id}`, p.year]));
    const dated = new Map<string, number | null>();
    for (const p of expansion.papers) {
      const id = (p.matchKey && ownedNode.get(p.matchKey)) || externalNodeId(p.s2Id);
      dated.set(id, yearOfOwned.get(id) ?? p.year);
    }
    dated.set(centre, yearOfOwned.get(centre) ?? null);

    const nodes = [...dated].map(([id, year]) => ({ id, year }));
    // Time on the horizontal axis, oldest left: lineage then reads left to
    // right, and the arrowheads confirm what the position already said.
    const homes = yearHomes(nodes);

    // …but only if it is drawn. The columns said "x is time" and nothing on the
    // page did, so the user was left to infer the one fact the whole view is
    // built on. Read back off the homes rather than recomputed, so a tick can
    // never disagree with the column it labels.
    const byX = new Map<number, string>();
    for (const { id, year } of nodes) {
      const home = homes.get(id);
      if (home) byX.set(home.x, year === null ? 'undated' : String(year));
    }
    const axis = [...byX].map(([x, label]) => ({ x, label })).sort((a, b) => a.x - b.x);

    return { centre, keep: new Set(dated.keys()), homes, axis };
  }, [view.lineageOf, graphCitations, papers]);

  // Items nothing links to are pulled out of the map entirely. In the force
  // layout they feel only repulsion, so they drift outward and push the real
  // clusters around while carrying no information themselves. Down here they
  // stop being noise and start being a to-do list: file one into a deck or a
  // topic and it joins the map.
  const { mapped, loose } = useMemo(() => {
    // In lineage mode everything on screen is part of the lineage, and a node
    // with no drawn edge is still one of its sources — so nothing is exiled to
    // the strip, and the columns are the structure.
    if (lineage) {
      const nodes = model.nodes.filter((n) => lineage.keep.has(n.id));
      const ids = new Set(nodes.map((n) => n.id));
      return {
        mapped: {
          ...model,
          nodes,
          edges: model.edges.filter((e) => ids.has(e.a) && ids.has(e.b)),
        },
        loose: [] as RenderNode[],
      };
    }
    const linked: RenderNode[] = [];
    const alone: RenderNode[] = [];
    for (const n of model.nodes) (n.degree > 0 ? linked : alone).push(n);
    return { mapped: { ...model, nodes: linked }, loose: alone };
  }, [model, lineage]);

  // What the CANVAS is empty of, which is not the same question as whether the
  // library is. Everything unconnected is pulled out into the strip below, so a
  // new user with a handful of unrelated bookmarks used to get a blank canvas
  // and a legend explaining lines that were not on it, with everything they had
  // saved folded into a collapsed <details> at the bottom.
  const mapEmpty = nodesLoaded && mapped.nodes.length === 0;
  useEffect(() => {
    if (mapEmpty) document.body.dataset.settled = 'true';
  }, [mapEmpty]);

  /** Kinds actually drawn, so the legend never names a shape that is not there. */
  const onScreen = useMemo(
    () => new Set<Kind>(mapped.nodes.map((n) => n.kind)),
    [mapped],
  );

  // Ghost papers three or more of your own converge on. Resolved to nodes here
  // so the strip and the canvas promote exactly the same set.
  const queue = useMemo(() => {
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    return readingQueue(model.cites).flatMap(({ id, owners }) => {
      const node = byId.get(id);
      return node ? [{ node, owners }] : [];
    });
  }, [model]);

  const promoted = useMemo(() => new Set(queue.map((q) => q.node.id)), [queue]);

  // Notes that name the selected node without linking it. Computed here
  // because only this page holds the decrypted text.
  const mentions = useMemo(() => {
    if (!selectedNode) return [];
    const linkable = linkableNotes(notes, annotations, locked);
    const index = mentionIndex([selectedNode]);
    return linkable.flatMap((note) => {
      const linked = new Set(
        parseWikiLinks(note.text).flatMap((t) => {
          const hit = resolveWikiLink(t, model.nodes);
          return hit ? [hit.id] : [];
        }),
      );
      const hits = unlinkedMentions(note, index, linked);
      return hits.length ? [{ note, title: noteLabel(note.text) }] : [];
    });
  }, [selectedNode, notes, annotations, locked, model]);

  // Publish what is actually drawn, for the assistant to read. In an effect on
  // the model — never in the paint loop, which runs sixty times a second.
  const publisherId = useRef(crypto.randomUUID()).current;
  const publishedRef = useRef<VisibleGraph | null>(null);
  useEffect(() => {
    if (!nodesLoaded) return;
    // Explicitly the best-connected, because model.nodes is now ordered by age
    // to keep the layout still. This used to inherit a degree sort by accident;
    // saying so out loud is what stops the next ordering change from quietly
    // handing the assistant the oldest forty nodes instead of the busiest.
    const shown = [...mapped.nodes]
      .sort((a, b) => b.degree - a.degree)
      .slice(0, GRAPH_DIGEST_MAX_NODES);
    const ids = new Set(shown.map((n) => n.id));
    const payload: VisibleGraph = {
      nodes: shown.map((n) => ({
        id: n.id,
        title: n.title,
        kind: n.kind,
        url: n.url,
        topics: n.tags,
        read: n.completion,
      })),
      // [citing, cited], and now actually in that order. This used to publish
      // the endpoints of an undirected edge, which sorts them alphabetically —
      // so every pair the assistant read had a 50% chance of being backwards.
      cites: mapped.cites
        .filter((c) => ids.has(c.from) && ids.has(c.to))
        .map((c) => [c.from, c.to] as [string, string]),
      selectedId: selected ?? '',
      topic,
      mode: lineage ? 'lineage' : 'map',
      updatedAt: Date.now(),
      publisherId,
    };
    publishedRef.current = payload;
    void setSession({ graphVisible: payload });
  }, [mapped, selected, topic, lineage, nodesLoaded, publisherId]);

  // Keep saying it. There is no reliable way to announce a closing page — a
  // navigation tears the document down before an async storage write lands —
  // so the assistant reads freshness instead, and this is what keeps a page
  // that is genuinely open from looking closed.
  useEffect(() => {
    const beat = setInterval(() => {
      const last = publishedRef.current;
      if (last) void setSession({ graphVisible: { ...last, updatedAt: Date.now() } });
    }, GRAPH_VISIBLE_HEARTBEAT_MS);
    return () => clearInterval(beat);
  }, []);

  const capped = model.totalNodes > model.nodes.length;

  /** How many filters are narrowing the view, for the badge on the button. */
  const filterCount = hidden.size + (topic ? 1 : 0);

  const clearFilters = useCallback(() => {
    setGraphView({ hiddenKinds: [], topic: '' });
  }, [setGraphView]);

  // Close the filter menu on an outside click. A <details> popover that only
  // shuts by clicking its own summary is a popover people leave open.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = filtersRef.current;
      if (el?.open && !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

  // What the canvas must not fit content underneath. The Ask panel only claims
  // the bottom-left corner, so it costs height rather than width — insetting
  // 340px of a narrow window for a panel that tall would waste the whole left
  // half of the map.
  const insets = useMemo(
    () => ({
      right: selectedNode ? INSPECTOR_WIDTH : 0,
      bottom: askOpen ? ASK_HEIGHT : 0,
      left: 0,
    }),
    [selectedNode, askOpen],
  );

  return (
    <div className="gr-page">
      <header className="gr-bar">
        <button
          className="ghost-btn"
          onClick={() => {
            location.href = chrome.runtime.getURL(NEWTAB_PAGE_PATH);
          }}
        >
          ← Dashboard
        </button>
        <h1>{lineage ? 'Where it came from' : 'Graph'}</h1>
        {lineage && (
          <button
            className="ghost-btn"
            title="Go back to the whole map"
            onClick={() => setGraphView({ lineageOf: '' })}
          >
            ← Whole map
          </button>
        )}

        {/* One filter control, not two languages for the same job. Eight
            pressable chips plus a <select> could not fit a 44px row without
            sliding into an unmarked horizontal scroller below ~1300px, and the
            two of them narrowed the same thing while looking nothing alike. */}
        {!lineage && (
          <details className="gr-filters" ref={filtersRef}>
            <summary className="gr-chip" aria-label="Filters">
              Filters
              {filterCount > 0 && <span className="gr-filter-count">{filterCount}</span>}
            </summary>
            <div className="gr-filter-menu">
              <h2 className="gr-filter-head">Show</h2>
              <div className="gr-chips" role="group" aria-label="Filter by kind">
                {KINDS.map((k) => (
                  <button
                    key={k.id}
                    className="gr-chip"
                    aria-pressed={!hidden.has(k.id)}
                    data-kind={k.id}
                    onClick={() => toggleKind(k.id)}
                  >
                    <span className="gr-glyph" data-kind={k.id} aria-hidden="true" />
                    {k.label}
                  </button>
                ))}
              </div>

              {topics.length > 0 && (
                <>
                  <h2 className="gr-filter-head">Topic</h2>
                  <select
                    className="gr-topic"
                    aria-label="Topic"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                  >
                    <option value="">Everything</option>
                    {topics.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </>
              )}

              <h2 className="gr-filter-head">Connections</h2>
              <div className="gr-chips" role="group" aria-label="Connection type">
                {([
                  ['evidence', 'Evidence'],
                  ['organization', 'Organization'],
                  ['discover', 'Discover'],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    className="gr-chip"
                    aria-pressed={connectionMode === id}
                    title={
                      id === 'evidence'
                        ? 'Citations, recordings, and explicit note links'
                        : id === 'organization'
                          ? 'Decks, groups, and source relationships'
                          : 'Shared topics and sites'
                    }
                    onClick={() => setConnectionMode(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </details>
        )}

        <div className="gr-search-wrap">
          <input
            className="gr-search"
            type="search"
            ref={searchRef}
            placeholder="Search  /"
            aria-label="Search the graph"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter frames the matches. Typing dims and labels as you go; the
              // map only jumps when you ask, because a view that chases every
              // keystroke is unusable.
              if (e.key === 'Enter' && matchCount) setFrameNonce((n) => n + 1);
            }}
          />
          {matchCount !== null && (
            <span className="gr-matches" data-none={matchCount === 0 ? 'true' : undefined}>
              {matchCount === 0
                ? 'No matches'
                : `${matchCount} match${matchCount === 1 ? '' : 'es'} · ↵ to show`}
            </span>
          )}
        </div>

        {!lineage && (unlabelled > 0 || sorting) && (
          <button
            className="ghost-btn"
            disabled={sorting !== null}
            title="Group everything by what it is about"
            onClick={() => void sortIntoTopics()}
          >
            {sorting
              ? `Sorting ${sorting.done} of ${sorting.total}`
              : `Sort into topics (${unlabelled})`}
          </button>
        )}

        <button
          className="ghost-btn"
          title={theme.resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={() => theme.setMode(theme.resolved === 'dark' ? 'light' : 'dark')}
        >
          {theme.resolved === 'dark' ? 'Light' : 'Dark'}
        </button>
      </header>

      {/* One status line, and one that can be acted on. The capped note used to
          be the only thing on the page that said how much was hidden, and it
          named the one cause the user cannot do anything about while saying
          nothing about the filters they set themselves. */}
      {!lineage && (capped || filterCount > 0) && (
        <p className="gr-note">
          {/* Only when the cap actually bit. `totalNodes` is counted after the
              kind filter, so hiding a kind lowers both halves and "14 of 14"
              was all a filtered view ever said. */}
          {capped &&
            `Showing ${model.nodes.filter((n) => n.kind !== 'external').length} of ${model.totalNodes} — narrowed to the most connected`}
          {capped && filterCount > 0 && ' · '}
          {filterCount > 0 && (
            <>
              {topic && <>Topic “{topic}”</>}
              {topic && hidden.size > 0 && ', '}
              {hidden.size > 0 && `${hidden.size} kind${hidden.size === 1 ? '' : 's'} hidden`}{' '}
              <button className="gr-inline-btn" onClick={clearFilters}>
                Clear filters
              </button>
            </>
          )}
        </p>
      )}

      <div
        className="gr-stage"
        // The inspector is a fixed panel over the right edge, and the Ask panel
        // over the bottom-left. Both are told to the canvas so its fit stops
        // centring content underneath them, and to the view controls so they
        // are not buried by either.
        style={
          {
            '--gr-chrome-right': selectedNode ? `${INSPECTOR_WIDTH}px` : '0px',
          } as React.CSSProperties
        }
      >
        {!lineage && (
          <div className="gr-surface-tabs" role="group" aria-label="Graph view">
            <button className="gr-surface-tab" aria-pressed={surface === 'map'} onClick={() => setSurface('map')}>
              Connections
            </button>
            <button className="gr-surface-tab" aria-pressed={surface === 'inbox'} onClick={() => setSurface('inbox')}>
              Library inbox{loose.length > 0 ? ` (${loose.length})` : ''}
            </button>
          </div>
        )}
        {!lineage && surface === 'inbox' ? (
          <section className="gr-inbox" aria-label="Unconnected library items">
            <h2>Library inbox</h2>
            <p>These items are not connected yet. Give one a topic, add it to a deck or group, or write about it.</p>
            {loose.length === 0 ? (
              <p className="gr-inbox-empty">Everything in this view has a connection.</p>
            ) : (
              <ul className="gr-inbox-list">
                {loose.map((n) => (
                  <li key={n.id}>
                    <button className="gr-inbox-item" onClick={() => setSelected(n.id)}>
                      <span className="gr-glyph" data-kind={n.kind} aria-hidden="true" />
                      <span><strong>{n.title}</strong><small>{n.source || 'No source or topic yet'}</small></span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : mapEmpty ? (
          topic ? (
            <p className="gr-empty">
              Nothing showing for {topic}.{' '}
              <button className="gr-inline-btn" onClick={() => setTopic('')}>
                Show everything
              </button>
            </p>
          ) : isEmpty ? (
            <p className="gr-empty">
              Nothing to map yet. Read an article, track a paper, or save a few links and they will
              show up here.
            </p>
          ) : (
            // The library is not empty; nothing in it is connected. Say so, and
            // say what connects things, rather than showing a blank canvas over
            // a collapsed list of everything the user has saved.
            <p className="gr-empty">
              None of your {loose.length} items are connected yet — they are all listed below. File
              a few into the same deck or link group, share a topic, or write a note that mentions
              two of them, and they will join up here.
            </p>
          )
        ) : (
          <GraphCanvas
            model={mapped}
            selected={selected}
            onSelect={setSelected}
            onOpen={openNode}
            query={query}
            homes={lineage?.homes ?? null}
            axis={lineage?.axis ?? null}
            // Similarity is noise in a lineage — a deck-mate or a same-site
            // article says nothing about provenance — so the layer is off there
            // and the toggle for it is not offered.
            connectionMode={lineage ? 'evidence' : connectionMode}
            promoted={promoted}
            insets={insets}
            onMatchCount={setMatchCount}
            frameMatchesNonce={frameNonce}
            focusId={view.focusId}
            focusNonce={focusFrameNonce}
          />
        )}

        {/* One channel per variable, written down. A mapping that lives only in
            the renderer is a mapping the reader has to reverse-engineer — and
            the ramp was the worst of them: node colour is the densest thing on
            the canvas and nothing on the page said what it meant.

            Behind a disclosure because all three channels at once is a wall,
            and closed it is one word in a corner. */}
        {!mapEmpty && (
          <details className="gr-legend">
            <summary>Key</summary>

            <h3 className="gr-legend-head">Lines</h3>
            <ul className="gr-legend-list">
              <li>
                <span className="gr-legend-mark" data-line="cite" aria-hidden="true" />
                builds on <span className="gr-legend-note">arrow points at the older work</span>
              </li>
              {model.mentions.length > 0 && (
                <li>
                  <span className="gr-legend-mark" data-line="mention" aria-hidden="true" />
                  named in a recording
                </li>
              )}
              {!lineage && connectionMode !== 'evidence' && (
                <li>
                  <span className="gr-legend-mark" data-line="similar" aria-hidden="true" />
                  {connectionMode === 'organization' ? 'organization' : 'discovery'} connection
                </li>
              )}
            </ul>

            <h3 className="gr-legend-head">Colour</h3>
            <p className="gr-legend-ramp" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((level) => (
                <span key={level} className="gr-legend-heat" data-level={level} />
              ))}
            </p>
            <p className="gr-legend-note">
              unread or long ago → read recently. Size is how many connections.
            </p>

            {/* Same glyphs as the filter chips, which are a control and so were
                never a key — a user reading the map has no reason to look at a
                row of toggles to find out what a diamond is. */}
            <h3 className="gr-legend-head">Shapes</h3>
            <ul className="gr-legend-shapes">
              {KINDS.filter((k) => !hidden.has(k.id) && onScreen.has(k.id)).map((k) => (
                <li key={k.id}>
                  <span className="gr-glyph" data-kind={k.id} aria-hidden="true" />
                  {k.legend}
                </li>
              ))}
            </ul>
          </details>
        )}
        <GraphAsk open={askOpen} onOpenChange={setAskOpen} />
      </div>

      {/* One tray, one height budget. These were two independently scrolling
          strips of up to 26vh and 22vh — with both expanded the map lost half a
          laptop screen to chrome that is only ever glanced at. */}
      {(queue.length > 0 || loose.length > 0) && (
      <div className="gr-tray">
      {queue.length > 0 && (
        <section className="gr-queue" aria-label={`Worth reading next, ${queue.length} papers`}>
          <h2 className="gr-queue-head">
            Worth reading next
            <span className="gr-queue-why">papers your own keep citing that you do not have</span>
          </h2>
          <ul className="gr-queue-list">
            {queue.map(({ node, owners }) => (
              <li key={node.id}>
                <button
                  className="gr-queue-item"
                  data-selected={node.id === selected ? 'true' : undefined}
                  title={node.title}
                  onClick={() => setSelected(node.id === selected ? null : node.id)}
                >
                  <span className="gr-queue-count" aria-hidden="true">
                    {owners}
                  </span>
                  <span className="gr-queue-text">
                    <span className="gr-queue-title">{node.title}</span>
                    <span className="gr-queue-meta">
                      cited by {owners} of your papers
                      {node.source ? ` · ${node.source}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Orphans are no longer a strip of their own — a flat list with nothing
          to do about it was dead space. They stay reachable rather than
          vanishing, because silently hiding something the user saved is worse
          than an unglamorous line of text. */}
      {loose.length > 0 && (
        // Open by default when it is the only thing there is — a collapsed
        // disclosure under a blank canvas hides the entire library behind a
        // click the user has no reason to suspect.
        <details className="gr-loose" open={mapEmpty}>
          <summary>Not connected yet ({loose.length})</summary>
          <ul className="gr-loose-list">
            {loose.map((n) => (
              <li key={n.id}>
                <button
                  className="gr-loose-item"
                  data-kind={n.kind}
                  data-selected={n.id === selected ? 'true' : undefined}
                  title={n.title}
                  onClick={() => setSelected(n.id === selected ? null : n.id)}
                >
                  <span className="gr-glyph" data-kind={n.kind} aria-hidden="true" />
                  <span className="gr-loose-title">{n.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      </div>
      )}

      {selectedNode && (
        <NodeInspector
          model={model}
          node={selectedNode}
          mentions={mentions}
          onSelect={setSelected}
          onOpen={openNode}
          onTopic={setTopic}
          onClose={() => setSelected(null)}
        />
      )}

      <p className="gr-status" role="status" aria-live="polite">
        {selectedNode ? `Selected: ${selectedNode.title}, ${selectedNode.degree} connections` : ''}
      </p>
    </div>
  );
}
