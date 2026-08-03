import { useEffect, useState } from 'react';
import { Button } from '../../../shared/components/ui';
import { sendMessage } from '../../../shared/messages';
import { citationRef } from '../../../shared/citations';
import { linkMention, type LinkableNote } from '../../../shared/wikilink';
import { neighborsOf, type EdgeReason, type GraphModel, type RenderNode } from '../../../shared/graphModel';

const KIND_LABEL: Record<RenderNode['kind'], string> = {
  article: 'Article',
  video: 'Video',
  paper: 'Paper',
  bookmark: 'Bookmark',
  recording: 'Recording',
  external: 'Not saved yet',
  note: 'Note',
  highlight: 'Highlight',
};

/** Why two things are linked, in the words a user would use. */
const REASON_LABEL: Record<EdgeReason, string> = {
  deck: 'same deck',
  group: 'same group',
  video: 'same video',
  annotation: 'you highlighted both',
  domain: 'same site',
  tag: 'shared topic',
  link: 'you linked them',
  mention: 'you wrote about this',
};

/**
 * Citation, said from the selected node's side. "One cites the other" was the
 * old label and it was the whole problem in miniature — true, and useless,
 * because it never said which one.
 */
const CITE_LABEL: Record<'builds-on' | 'cited-by', string> = {
  'builds-on': 'this builds on it',
  'cited-by': 'it builds on this',
};

/** Said from the selected node's side, like the citation labels above. */
function mentionLabel(kind: RenderNode['kind']): string {
  return kind === 'recording' ? 'this names it' : 'named in this recording';
}

/** mm:ss into the recording, so the quote can be found and played. */
function atLabel(atSec: number): string {
  const m = Math.floor(atSec / 60);
  const s = Math.floor(atSec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** A note that names this node without linking it, and the text to rewrite. */
export interface Mention {
  note: LinkableNote;
  /** The note's opening words, so the user can tell which note it is */
  title: string;
}

interface Props {
  model: GraphModel;
  node: RenderNode;
  /** Notes naming this node without a link — the "Connect" candidates */
  mentions: Mention[];
  onSelect: (id: string) => void;
  onOpen: (node: RenderNode) => void;
  /** Narrow the whole graph to one topic — the tags double as the filter */
  onTopic: (topic: string) => void;
  onClose: () => void;
}

export function NodeInspector({
  model,
  node,
  mentions,
  onSelect,
  onOpen,
  onTopic,
  onClose,
}: Props) {
  const neighbors = neighborsOf(model, node.id);
  const [expanding, setExpanding] = useState(false);
  const [expandNote, setExpandNote] = useState('');
  const [adding, setAdding] = useState<'idle' | 'adding' | 'added'>('idle');
  const [wrote, setWrote] = useState(false);
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [newTopic, setNewTopic] = useState('');
  const [savingTopics, setSavingTopics] = useState(false);

  // Reset per node, or the last paper's result is still on screen for the next.
  useEffect(() => {
    setExpanding(false);
    setExpandNote('');
    setAdding('idle');
    setWrote(false);
    setConnected(new Set());
    setNewTopic('');
    setSavingTopics(false);
  }, [node.id]);

  const paperId = node.kind === 'paper' ? node.id.slice('paper:'.length) : '';
  // Not parsePaperRef: that accepts any URL, so the button would never
  // disable for a paper with no identifier the sources can resolve.
  const canExpand = node.kind === 'paper' && citationRef({ url: node.url }) !== null;

  async function onExpand() {
    setExpanding(true);
    setExpandNote('');
    const res = await sendMessage({ type: 'GRAPH_EXPAND_CITATIONS', paperId });
    setExpanding(false);
    // Both halves say something useful: the failure names the next move, and
    // the success says how much arrived and from where.
    setExpandNote(res.ok ? (res.note ?? '') : (res.error ?? ''));
  }

  // Seeded with the link already written, so the connection exists the moment
  // the note does — asking the user to type [[…]] from memory is how a linking
  // feature ends up unused.
  async function onWrite() {
    await sendMessage({ type: 'SAVE_NOTE', rawText: `[[${node.title}]] ` });
    setWrote(true);
  }

  /**
   * Turn a mention into a real link by writing `[[…]]` into the note itself.
   * The edit happens in the note's own words, so the link survives wherever the
   * note is read — it is not graph metadata sitting off to one side.
   */
  async function onConnect(note: LinkableNote) {
    const next = linkMention(note.text, node.title);
    if (next === note.text) return;
    const res = await sendMessage({
      type: 'NOTE_ADD_LINK',
      id: note.id.slice('note:'.length),
      rawText: next,
    });
    if (res.ok) setConnected((prev) => new Set(prev).add(note.id));
  }

  async function onAdd() {
    setAdding('adding');
    const res = await sendMessage({ type: 'GRAPH_ADD_EXTERNAL', nodeId: node.id });
    setAdding(res.ok ? 'added' : 'idle');
    if (!res.ok && res.error) setExpandNote(res.error);
  }

  // Notes/highlights are projected rather than stored in graphNodes, and an
  // external belongs to its citation cache. The remaining kinds have a durable
  // graph record, so a correction made here survives the next enrichment run.
  const canEditTopics = !['external', 'note', 'highlight'].includes(node.kind);
  async function saveTopics(tags: string[]) {
    setSavingTopics(true);
    await sendMessage({ type: 'GRAPH_SET_MANUAL_TAGS', id: node.id, tags });
    setSavingTopics(false);
  }

  function addTopic() {
    const tag = newTopic.trim().toLowerCase();
    if (!tag || node.tags.includes(tag)) return;
    void saveTopics([...node.tags, tag]);
    setNewTopic('');
  }

  return (
    <aside className="gr-inspector" aria-label={`Details for ${node.title}`}>
      <div className="gr-inspector-head">
        <span className="gr-kind" data-kind={node.kind}>
          {KIND_LABEL[node.kind]}
        </span>
        <button className="ghost-btn" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </div>

      <h2 className="gr-inspector-title">{node.title}</h2>
      {node.source && <p className="gr-inspector-meta">{node.source}</p>}
      {node.completion > 0 && (
        <p className="gr-inspector-meta">{Math.round(node.completion * 100)}% through</p>
      )}

      {(node.tags.length > 0 || canEditTopics) && (
        <ul className="gr-tags" aria-label="Topics">
          {node.tags.map((tag) => (
            <li key={tag}>
              <button
                className="gr-tag"
                title={`Show only ${tag}`}
                onClick={() => onTopic(tag)}
              >
                {tag}
              </button>
              {canEditTopics && (
                <button
                  className="gr-tag-remove"
                  aria-label={`Remove ${tag}`}
                  title={`Remove ${tag}`}
                  disabled={savingTopics}
                  onClick={() => void saveTopics(node.tags.filter((t) => t !== tag))}
                >
                  ×
                </button>
              )}
            </li>
          ))}
          {canEditTopics && (
            <li className="gr-tag-add">
              <input
                value={newTopic}
                maxLength={60}
                placeholder="Add topic"
                aria-label="Add topic"
                onChange={(e) => setNewTopic(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addTopic();
                }}
              />
              <button className="gr-connect" disabled={!newTopic.trim() || savingTopics} onClick={addTopic}>
                Add
              </button>
            </li>
          )}
        </ul>
      )}

      {node.kind === 'external' ? (
        <>
          <Button block onClick={onAdd} disabled={adding !== 'idle'}>
            {adding === 'added' ? 'Added ✓' : adding === 'adding' ? 'Adding…' : 'Add to my papers'}
          </Button>
          <button className="ghost-btn gr-secondary" onClick={() => onOpen(node)}>
            Open where it lives
          </button>
        </>
      ) : (
        <Button block onClick={() => onOpen(node)}>
          {node.completion > 0 && node.completion < 0.9 ? 'Continue' : 'Open'}
        </Button>
      )}

      {node.kind !== 'note' && (
        <button
          className="ghost-btn gr-secondary"
          disabled={wrote}
          title="Start a brain dump already linked to this"
          onClick={onWrite}
        >
          {wrote ? 'Note started ✓' : 'Write about this'}
        </button>
      )}

      {node.kind === 'paper' && (
        <>
          <button
            className="ghost-btn gr-secondary"
            disabled={expanding || !canExpand}
            title={
              canExpand
                ? 'Look up what this cites and what cites it'
                : 'This paper has no arXiv id or DOI, so there is nothing to look up'
            }
            onClick={onExpand}
          >
            {expanding ? 'Looking…' : 'Show what this cites'}
          </button>
          {expandNote && <p className="gr-inspector-meta">{expandNote}</p>}
        </>
      )}

      {mentions.length > 0 && (
        <>
          <h3 className="gr-inspector-sub">You wrote about this</h3>
          <ul className="gr-neighbors">
            {mentions.map((m) => (
              <li key={m.note.id}>
                <div className="gr-mention">
                  <span className="gr-neighbor-title">{m.title}</span>
                  <button
                    className="gr-connect"
                    disabled={connected.has(m.note.id)}
                    title="Write the link into the note"
                    onClick={() => void onConnect(m.note)}
                  >
                    {connected.has(m.note.id) ? 'Connected ✓' : 'Connect'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="gr-inspector-sub">
        Connected to {neighbors.length === 0 ? 'nothing yet' : `${neighbors.length}`}
      </h3>
      {neighbors.length === 0 ? (
        <p className="gr-inspector-meta">
          Nothing links to this yet. File it in a deck or a link group and it will join a cluster.
        </p>
      ) : (
        <ul className="gr-neighbors">
          {neighbors.map((n) => (
            <li key={n.node.id}>
              <button
                className="gr-neighbor"
                data-cites={n.cites ?? undefined}
                onClick={() => onSelect(n.node.id)}
              >
                <span className="gr-neighbor-title">{n.node.title}</span>
                <span className="gr-neighbor-why">
                  {[
                    ...(n.cites ? [CITE_LABEL[n.cites]] : []),
                    ...(n.mention ? [mentionLabel(node.kind)] : []),
                    ...n.reasons.map((r) => REASON_LABEL[r]),
                  ].join(' · ')}
                </span>
                {/* The sentence that justified the edge. An inferred link the
                    user cannot check is one they are right not to trust. */}
                {n.mention && (
                  <span className="gr-neighbor-evidence">
                    “{n.mention.evidence}” <span className="gr-at">{atLabel(n.mention.atSec)}</span>
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
