import { useEffect, useMemo, useState } from 'react';
import { allReferences, type ReferenceIndex } from '../../../shared/bibliography';
import { buildLineage, lineageStats, UNGROUPED, type LineageEntry } from '../../../shared/citationLineage';
import { enrichTopics } from '../../../shared/ai/topics';
import { citationRef } from '../../../shared/citations';
import { backlinksFor } from '../../../shared/docCitations';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { sendMessage } from '../../../shared/messages';
import type { Paper } from '../../../shared/types';
import type { KnownTarget } from '../citationLinks';

/**
 * Where this paper's ideas came from.
 *
 * Replaces a force-directed map that could not work here: in a 320px rail it
 * drew four topic headings on top of each other, nothing was legible, and
 * nothing was clickable. A list grouped by subject and ordered by year answers
 * the question the map was trying to — read it top to bottom and you are
 * reading the order the ideas arrived in — and every row is a real target.
 *
 * The document's own bibliography is the spine, so this works with no network
 * at all; a citation expansion, when there is one, adds the subjects and the
 * real titles.
 */

/** Groups opened on arrival — enough to see the shape without a wall of rows. */
const OPEN_GROUPS = 2;

function openTarget(target: KnownTarget): void {
  const url = target.path ? chrome.runtime.getURL(target.path) : target.externalUrl;
  if (url) void chrome.tabs.create({ url });
}

function Row({ entry, known }: { entry: LineageEntry; known: Map<string, KnownTarget> }) {
  const mine = entry.ownedKey ? (known.get(entry.ownedKey) ?? null) : null;
  const body = (
    <>
      <span className="reader-lineage-title">{entry.title}</span>
      <span className="reader-lineage-meta">
        {entry.year ?? '—'}
        {mine && <span className="reader-lineage-mine"> · in your papers</span>}
      </span>
    </>
  );

  // Yours opens your copy, with your highlights on it. Anything else opens
  // where it lives — and an entry with no link at all is still shown, just as
  // plain text, rather than pretending to be a button that does nothing.
  if (mine) {
    return (
      <button className="reader-lineage-row" onClick={() => openTarget(mine)}>
        {body}
      </button>
    );
  }
  if (entry.externalUrl) {
    return (
      <a className="reader-lineage-row" href={entry.externalUrl} target="_blank" rel="noreferrer">
        {body}
      </a>
    );
  }
  return <span className="reader-lineage-row is-plain">{body}</span>;
}

export function RelatedPanel({
  docKey,
  paper,
  references,
  known,
  onClose,
}: {
  /** This document's match key — how other documents refer to it */
  docKey: string;
  /** The tracked paper this document is, when it is one */
  paper: Paper | null;
  references: ReferenceIndex | null;
  known: Map<string, KnownTarget>;
  onClose: () => void;
}) {
  const [docCitations] = useStorageValue('docCitations');
  const [graphCitations] = useStorageValue('graphCitations');
  const [expanding, setExpanding] = useState(false);
  const [expandNote, setExpandNote] = useState('');
  const [sorting, setSorting] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    setExpanding(false);
    setExpandNote('');
  }, [docKey]);

  const expansion = paper ? (graphCitations[paper.id] ?? null) : null;
  const canExpand = paper !== null && citationRef(paper) !== null;

  // Match keys the reader already owns, resolved once from the same index the
  // citation markers use.
  const owned = useMemo(() => {
    const keys = new Set<string>();
    for (const [key] of known) keys.add(key);
    return keys;
  }, [known]);

  const groups = useMemo(
    () => buildLineage(references ? allReferences(references) : [], expansion, owned),
    [references, expansion, owned],
  );
  const stats = useMemo(() => lineageStats(groups), [groups]);
  // Only what a source could have labelled and did not — a bibliography entry
  // no index knows about has no title worth guessing from.
  const untopiced = useMemo(
    () =>
      (expansion?.papers ?? []).filter((p) => p.relation === 'reference' && p.topics.length === 0)
        .length,
    [expansion],
  );

  const citedBy = useMemo(() => backlinksFor(docKey, docCitations), [docKey, docCitations]);

  async function onExpand() {
    if (!paper) return;
    setExpanding(true);
    setExpandNote('');
    const res = await sendMessage({ type: 'GRAPH_EXPAND_CITATIONS', paperId: paper.id });
    setExpanding(false);
    setExpandNote(res.ok ? (res.note ?? '') : (res.error ?? ''));
  }

  /**
   * Label the cited papers no source gave a subject for.
   *
   * The library's own topics are handed in as vocabulary but never relabelled,
   * so a cited paper lands under the same heading as the papers already on the
   * shelf — which is what makes "you already have 2 of these" mean something.
   */
  async function sortRest() {
    const untagged = (expansion?.papers ?? []).filter(
      (p) => p.relation === 'reference' && p.topics.length === 0,
    );
    if (!untagged.length) return;

    setSorting({ done: 0, total: untagged.length });
    try {
      await enrichTopics(
        untagged.map((p) => ({
          id: p.s2Id,
          title: p.title,
          source: p.venue,
          url: p.url,
          tags: [],
          tagSource: 'auto' as const,
          tagInputHash: '',
        })),
        {
          onProgress: setSorting,
          apply: async (assignments) => {
            await sendMessage({
              type: 'GRAPH_SET_CITED_TAGS',
              assignments: assignments.map((a) => ({ id: a.id, tags: a.tags })),
            });
          },
        },
      );
    } finally {
      setSorting(null);
    }
  }

  return (
    <aside className="reader-related" aria-label="Related">
      <div className="reader-related-head">
        <h2>Related</h2>
        <button className="ghost-btn" onClick={onClose} aria-label="Close related">
          ✕
        </button>
      </div>

      <h3 className="reader-related-sub">
        Builds on{stats.total > 0 && ` (${stats.total})`}
      </h3>

      {references === null ? (
        <p className="reader-related-empty">Reading the reference list…</p>
      ) : stats.total === 0 ? (
        <p className="reader-related-empty">
          No reference list found in this document. Nothing to follow from here yet.
        </p>
      ) : (
        <>
          {stats.owned > 0 && (
            <p className="reader-related-note">
              You already have {stats.owned} of these.
            </p>
          )}
          {groups.map((group, i) => (
            <details key={group.topic} className="reader-lineage-group" open={i < OPEN_GROUPS}>
              <summary>
                <span className="reader-lineage-topic">
                  {group.topic === UNGROUPED ? 'Everything else' : group.topic}
                </span>
                <span className="reader-lineage-count">{group.entries.length}</span>
              </summary>
              <ul className="reader-lineage-list">
                {group.entries.map((entry) => (
                  <li key={entry.id}>
                    <Row entry={entry} known={known} />
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </>
      )}

      {/* Subjects come from the citation index, so a paper that has never been
          looked up is grouped under one heading until it is. */}
      {canExpand && !expansion && stats.total > 0 && (
        <button className="reader-related-action" disabled={expanding} onClick={() => void onExpand()}>
          {expanding ? 'Looking…' : 'Look these up'}
        </button>
      )}

      {/* And the sources do not cover everything — the ones they missed can be
          labelled from the same vocabulary as the rest of the library. */}
      {expansion && untopiced > 0 && (
        <button className="reader-related-action" disabled={sorting !== null} onClick={() => void sortRest()}>
          {sorting
            ? `Sorting ${sorting.done} of ${sorting.total}`
            : `Sort the rest into topics (${untopiced})`}
        </button>
      )}
      {expandNote && <p className="reader-related-empty">{expandNote}</p>}

      <h3 className="reader-related-sub">
        Builds on it{citedBy.length > 0 && ` (${citedBy.length})`}
      </h3>
      {citedBy.length === 0 ? (
        <p className="reader-related-empty">
          Nothing you have read cites this yet. Open a paper that does and it will show up here.
        </p>
      ) : (
        <ul className="reader-lineage-list">
          {citedBy.map((doc) => (
            <li key={doc.docKey}>
              <button
                className="reader-lineage-row"
                onClick={() => void chrome.tabs.create({ url: doc.docUrl })}
              >
                <span className="reader-lineage-title">{doc.title}</span>
                <span className="reader-lineage-meta">from your library</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
