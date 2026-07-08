import { useState } from 'react';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { fetchPaperMeta } from '../../../shared/papers';
import { DEFAULT_SETTINGS } from '../../../shared/storage';
import type { Deck, PaperDraft, PaperStatus } from '../../../shared/types';

export function emptyPaperDraft(deckId: string): PaperDraft {
  return {
    deckId,
    title: '',
    authors: '',
    venue: '',
    year: null,
    citations: null,
    url: '',
    abstract: '',
    relevance: '',
    status: 'to-read',
    progressPercent: 0,
    leftOff: '',
  };
}

const STATUSES: { value: PaperStatus; label: string }[] = [
  { value: 'to-read', label: 'To read' },
  { value: 'reading', label: 'Reading' },
  { value: 'read', label: 'Read' },
];

function numOrNull(v: string): number | null {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

export function PaperForm({
  decks,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  decks: Deck[];
  initial: PaperDraft;
  submitLabel: string;
  onSubmit: (draft: PaperDraft) => Promise<{ ok: boolean; error?: string }>;
  onCancel: () => void;
}) {
  const [storedSettings] = useStorageValue('settings');
  const apiKey = { ...DEFAULT_SETTINGS, ...storedSettings }.semanticScholarApiKey;
  const [draft, setDraft] = useState<PaperDraft>(initial);
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof PaperDraft>(key: K, value: PaperDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const fetchMeta = async () => {
    if (!draft.url.trim()) return;
    setFetching(true);
    setFetchMsg(null);
    const result = await fetchPaperMeta(draft.url, apiKey);
    setFetching(false);
    if (!result.ok) {
      setFetchMsg(result.message);
      return;
    }
    const meta = result.meta;
    setDraft((d) => ({
      ...d,
      title: meta.title || d.title,
      authors: meta.authors || d.authors,
      venue: meta.venue || d.venue,
      year: meta.year ?? d.year,
      citations: meta.citations ?? d.citations,
      abstract: meta.abstract || d.abstract,
      url: meta.url || d.url,
    }));
    setFetchMsg('Fetched ✔ — review and edit anything below.');
  };

  const submit = async () => {
    if (!draft.title.trim()) {
      setError('A title is required (fetch it or type it in).');
      return;
    }
    setSaving(true);
    const res = await onSubmit(draft);
    setSaving(false);
    if (!res.ok) setError(res.error ?? 'Could not save.');
  };

  return (
    <form
      className="pp-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="pp-fetch-row">
        <input
          type="text"
          value={draft.url}
          onChange={(e) => set('url', e.target.value)}
          placeholder="Paste an arXiv / DOI / paper URL…"
        />
        <button
          type="button"
          className="fc-primary-btn"
          disabled={!draft.url.trim() || fetching}
          onClick={() => void fetchMeta()}
        >
          {fetching ? 'Fetching…' : 'Fetch'}
        </button>
      </div>
      {fetchMsg && <p className="pp-fetch-msg">{fetchMsg}</p>}

      <label className="pp-field">
        <span>Title</span>
        <input type="text" value={draft.title} onChange={(e) => set('title', e.target.value)} />
      </label>
      <label className="pp-field">
        <span>Authors</span>
        <input
          type="text"
          value={draft.authors}
          onChange={(e) => set('authors', e.target.value)}
          placeholder="Comma-separated"
        />
      </label>
      <div className="pp-field-row">
        <label className="pp-field">
          <span>Venue / conference</span>
          <input type="text" value={draft.venue} onChange={(e) => set('venue', e.target.value)} />
        </label>
        <label className="pp-field pp-field-sm">
          <span>Year</span>
          <input
            type="text"
            inputMode="numeric"
            value={draft.year ?? ''}
            onChange={(e) => set('year', numOrNull(e.target.value))}
          />
        </label>
        <label className="pp-field pp-field-sm">
          <span>Citations</span>
          <input
            type="text"
            inputMode="numeric"
            value={draft.citations ?? ''}
            onChange={(e) => set('citations', numOrNull(e.target.value))}
          />
        </label>
      </div>
      <label className="pp-field">
        <span>Abstract / description</span>
        <textarea
          rows={4}
          value={draft.abstract}
          onChange={(e) => set('abstract', e.target.value)}
        />
      </label>
      <label className="pp-field">
        <span>Relevance — why it matters to you</span>
        <textarea
          rows={2}
          value={draft.relevance}
          onChange={(e) => set('relevance', e.target.value)}
        />
      </label>

      <div className="pp-field-row">
        <label className="pp-field">
          <span>Deck</span>
          <select value={draft.deckId} onChange={(e) => set('deckId', e.target.value)}>
            {decks.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="pp-field">
          <span>Status</span>
          <select
            value={draft.status}
            onChange={(e) => set('status', e.target.value as PaperStatus)}
          >
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="pp-field pp-field-sm">
          <span>Progress %</span>
          <input
            type="number"
            min={0}
            max={100}
            value={draft.progressPercent}
            onChange={(e) =>
              set('progressPercent', Math.max(0, Math.min(100, Number(e.target.value) || 0)))
            }
          />
        </label>
      </div>
      <label className="pp-field">
        <span>Where I left off</span>
        <input
          type="text"
          value={draft.leftOff}
          onChange={(e) => set('leftOff', e.target.value)}
          placeholder="e.g. Section 4.2 — ablations"
        />
      </label>

      <div className="pp-form-actions">
        <button type="button" className="ghost-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="fc-primary-btn" disabled={saving}>
          {saving ? 'Saving…' : submitLabel}
        </button>
      </div>
      {error && <p className="fc-error">{error}</p>}
    </form>
  );
}
