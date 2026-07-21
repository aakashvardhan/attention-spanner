import { useState } from 'react';
import { sendMessage } from '../../../shared/messages';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { fetchPaperMeta, normalizeTitle, paperMatchKey } from '../../../shared/papers';
import { DEFAULT_SETTINGS } from '../../../shared/storage';
import type { Paper, PaperDraft } from '../../../shared/types';

/** The position-derived fields the prompt seeds a new paper with. */
export type PaperSeed = Pick<Paper, 'progressPercent' | 'leftOff' | 'pdf'>;

/**
 * Slim banner shown for a PDF that isn't in the papers list. Expanding it
 * prefetches metadata (arXiv /pdf/ URLs resolve via Semantic Scholar) into a
 * 4-field form; saving turns progress tracking on. Deliberately not the
 * full-page PaperForm — abstract/relevance/status can be edited later.
 */
export function TrackPrompt({
  src,
  suggestedTitle,
  getSeed,
}: {
  src: string;
  /** Title from the PDF metadata, used until the lookup answers */
  suggestedTitle: string;
  /** Current reading position, captured at save time */
  getSeed: () => PaperSeed;
}) {
  const [decks] = useStorageValue('decks');
  const [papers] = useStorageValue('papers');
  const [storedSettings] = useStorageValue('settings');
  const apiKey = { ...DEFAULT_SETTINGS, ...storedSettings }.semanticScholarApiKey;
  const paperDecks = decks.filter((d) => d.kind === 'papers');

  const [open, setOpen] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [authors, setAuthors] = useState('');
  const [venue, setVenue] = useState('');
  const [year, setYear] = useState<number | null>(null);
  const [meta, setMeta] = useState<{ citations: number | null; abstract: string; url: string }>({
    citations: null,
    abstract: '',
    url: '',
  });
  const [deckId, setDeckId] = useState('');
  const [newDeckName, setNewDeckName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expand = () => {
    setOpen(true);
    setTitle((t) => t || suggestedTitle);
    setDeckId((id) => id || paperDecks[0]?.id || '');
    void (async () => {
      const result = await fetchPaperMeta(src, apiKey);
      if (!result.ok) {
        setFetchMsg(result.message);
        return;
      }
      setTitle((t) => result.meta.title || t);
      setAuthors((a) => result.meta.authors || a);
      setVenue((v) => result.meta.venue || v);
      setYear((y) => result.meta.year ?? y);
      setMeta({
        citations: result.meta.citations,
        abstract: result.meta.abstract,
        // Canonical page (arXiv abs) when known; the reader still opens `pdf.url`
        url: result.meta.url,
      });
    })();
  };

  const save = async () => {
    if (!title.trim()) {
      setError('A title is required.');
      return;
    }
    setSaving(true);
    setError(null);

    // The reader only failed to match this PDF by URL — the same paper may
    // still be in the list under another link (project page, DOI, …). Link the
    // PDF to that record instead of creating a duplicate.
    const canonicalUrl = meta.url || src;
    const urlKeys = new Set(
      [paperMatchKey(src), paperMatchKey(canonicalUrl)].filter((k): k is string => k !== null),
    );
    const titleKey = normalizeTitle(title);
    const existing = papers.find((p) => {
      const key = paperMatchKey(p.url);
      return (key !== null && urlKeys.has(key)) || normalizeTitle(p.title) === titleKey;
    });
    if (existing) {
      const seed = getSeed();
      const patch: Partial<PaperDraft> = { leftOff: seed.leftOff, pdf: seed.pdf };
      // A finished paper stays 'read' (same rule as applyReaderProgress)
      if (existing.status === 'to-read') patch.status = 'reading';
      const res = await sendMessage({ type: 'PAPER_UPDATE', id: existing.id, patch });
      setSaving(false);
      if (!res.ok) setError(res.error ?? 'Could not save.');
      return;
    }

    let targetDeckId = deckId;
    if (!targetDeckId) {
      const name = newDeckName.trim() || 'Papers';
      const res = await sendMessage({ type: 'FLASH_ADD_DECK', name, kind: 'papers' });
      if (!res.ok || !res.deck) {
        setSaving(false);
        setError(res.error ?? 'Could not create a deck.');
        return;
      }
      targetDeckId = res.deck.id;
    }
    const draft: PaperDraft = {
      deckId: targetDeckId,
      title: title.trim(),
      authors,
      venue,
      year,
      citations: meta.citations,
      url: meta.url || src,
      abstract: meta.abstract,
      relevance: '',
      status: 'reading',
      ...getSeed(),
    };
    const res = await sendMessage({ type: 'PAPER_ADD', draft });
    setSaving(false);
    if (!res.ok) setError(res.error ?? 'Could not save.');
    // On success the papers storage updates, the reader matches the new
    // record, and this banner unmounts by itself.
  };

  if (!open) {
    return (
      <div className="reader-track-banner">
        <span>Not tracking this paper — progress won't be saved.</span>
        <button className="fc-primary-btn" onClick={expand}>
          Track this paper
        </button>
      </div>
    );
  }

  return (
    <form
      className="reader-track-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {fetchMsg && <p className="reader-track-msg">{fetchMsg}</p>}
      <div className="reader-track-fields">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
        />
        <input
          type="text"
          value={authors}
          onChange={(e) => setAuthors(e.target.value)}
          placeholder="Authors (comma-separated)"
        />
        <input
          type="text"
          value={venue}
          onChange={(e) => setVenue(e.target.value)}
          placeholder="Venue"
        />
        <input
          type="text"
          inputMode="numeric"
          className="reader-track-year"
          value={year ?? ''}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            setYear(Number.isFinite(n) ? n : null);
          }}
          placeholder="Year"
        />
        {paperDecks.length > 0 ? (
          <select value={deckId} onChange={(e) => setDeckId(e.target.value)}>
            {paperDecks.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={newDeckName}
            onChange={(e) => setNewDeckName(e.target.value)}
            placeholder="New deck name (e.g. Papers)"
          />
        )}
      </div>
      <div className="reader-track-actions">
        <button type="button" className="ghost-btn" onClick={() => setOpen(false)}>
          Not now
        </button>
        <button type="submit" className="fc-primary-btn" disabled={saving}>
          {saving ? 'Saving…' : 'Start tracking'}
        </button>
      </div>
      {error && <p className="fc-error">{error}</p>}
    </form>
  );
}
