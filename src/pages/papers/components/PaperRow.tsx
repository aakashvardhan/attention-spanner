import { useState } from 'react';
import { formatRelativeDate } from '../../../shared/format';
import type { Deck, Paper, PaperDraft, PaperStatus } from '../../../shared/types';
import { PaperForm } from './PaperForm';

const STATUS_LABEL: Record<PaperStatus, string> = {
  'to-read': 'To read',
  reading: 'Reading',
  read: 'Read',
};

export function PaperRow({
  paper,
  decks,
  onUpdate,
  onDelete,
}: {
  paper: Paper;
  decks: Deck[];
  onUpdate: (id: string, patch: Partial<PaperDraft>) => Promise<{ ok: boolean; error?: string }>;
  onDelete: (id: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [leftOff, setLeftOff] = useState(paper.leftOff);
  const [percent, setPercent] = useState(String(paper.progressPercent));

  if (editing) {
    return (
      <div className="panel pp-row pp-row-editing">
        <PaperForm
          decks={decks}
          initial={{
            deckId: paper.deckId,
            title: paper.title,
            authors: paper.authors,
            venue: paper.venue,
            year: paper.year,
            citations: paper.citations,
            url: paper.url,
            abstract: paper.abstract,
            relevance: paper.relevance,
            status: paper.status,
            progressPercent: paper.progressPercent,
            leftOff: paper.leftOff,
          }}
          submitLabel="Save changes"
          onCancel={() => setEditing(false)}
          onSubmit={async (draft) => {
            const res = await onUpdate(paper.id, draft);
            if (res.ok) setEditing(false);
            return res;
          }}
        />
      </div>
    );
  }

  const meta = [paper.venue, paper.year ?? null, paper.citations != null ? `${paper.citations} citations` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="panel pp-row">
      <div className="pp-row-head">
        <div className="pp-row-title-wrap">
          {paper.url ? (
            <a className="pp-row-title" href={paper.url} target="_blank" rel="noreferrer">
              {paper.title}
            </a>
          ) : (
            <span className="pp-row-title">{paper.title}</span>
          )}
          {paper.authors && <p className="pp-row-authors">{paper.authors}</p>}
          {meta && <p className="pp-row-meta">{meta}</p>}
        </div>
        <span className={`pp-status pp-status-${paper.status}`}>{STATUS_LABEL[paper.status]}</span>
      </div>

      <div className="dash-bar pp-bar">
        <div className="dash-bar-fill" style={{ width: `${paper.progressPercent}%` }} />
      </div>

      <div className="pp-controls">
        <select
          value={paper.status}
          title="Reading status"
          onChange={(e) => void onUpdate(paper.id, { status: e.target.value as PaperStatus })}
        >
          <option value="to-read">To read</option>
          <option value="reading">Reading</option>
          <option value="read">Read</option>
        </select>
        <label className="pp-pct">
          <input
            type="number"
            min={0}
            max={100}
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            onBlur={() => {
              const n = Math.max(0, Math.min(100, Number(percent) || 0));
              setPercent(String(n));
              if (n !== paper.progressPercent) void onUpdate(paper.id, { progressPercent: n });
            }}
          />
          <span>%</span>
        </label>
        <input
          className="pp-leftoff"
          type="text"
          value={leftOff}
          placeholder="Where I left off…"
          onChange={(e) => setLeftOff(e.target.value)}
          onBlur={() => {
            if (leftOff !== paper.leftOff) void onUpdate(paper.id, { leftOff });
          }}
        />
        {paper.status !== 'read' && (
          <button
            className="ghost-btn"
            title="Mark as read (100%)"
            onClick={() => void onUpdate(paper.id, { status: 'read', progressPercent: 100 })}
          >
            ✓ read
          </button>
        )}
      </div>

      {expanded && (
        <div className="pp-details">
          {paper.abstract && (
            <p className="pp-detail">
              <span className="row-label">Abstract</span>
              {paper.abstract}
            </p>
          )}
          {paper.relevance && (
            <p className="pp-detail">
              <span className="row-label">Relevance</span>
              {paper.relevance}
            </p>
          )}
        </div>
      )}

      <div className="pp-row-foot">
        <span className="pp-updated">Updated {formatRelativeDate(new Date(paper.updatedAt))}</span>
        <div className="pp-row-actions">
          {(paper.abstract || paper.relevance) && (
            <button className="ghost-btn" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Less' : 'Details'}
            </button>
          )}
          {paper.url && (
            <a className="ghost-btn" href={paper.url} target="_blank" rel="noreferrer">
              Open ↗
            </a>
          )}
          <button className="ghost-btn" onClick={() => setEditing(true)}>
            ✎
          </button>
          <button
            className="ghost-btn"
            title="Delete paper"
            onClick={() => {
              if (window.confirm(`Delete "${paper.title}"?`)) void onDelete(paper.id);
            }}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
