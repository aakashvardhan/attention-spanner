import { useEffect, useState } from 'react';
import { sendMessage } from '../../../shared/messages';
import { useSettings } from '../../../shared/hooks/useSettings';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { fetchPaperMeta, parsePaperRef, type FetchMetaResult, type PaperMeta } from '../../../shared/papers';
import { readerPagePath } from '../../../shared/pdf';
import { knownTargetFor, type KnownTarget } from '../citationLinks';
import { citationHref, type Reference } from '../references';

/** Lookups survive the tooltip closing, so re-hovering a citation is instant. */
const metaCache = new Map<string, Promise<FetchMetaResult>>();

/** Hovering across markers shouldn't fire a lookup per marker passed over. */
const LOOKUP_DELAY_MS = 350;

/** Semantic Scholar metadata for a reference with an arXiv id or DOI; null otherwise. */
function useRefMeta(link: string | null): PaperMeta | null {
  const [settings] = useSettings();
  const apiKey = settings.semanticScholarApiKey;
  const [meta, setMeta] = useState<PaperMeta | null>(null);
  useEffect(() => {
    const ref = link ? parsePaperRef(link) : null;
    if (!link || !ref || ref.startsWith('URL:')) return;
    let alive = true;
    const timer = setTimeout(() => {
      let pending = metaCache.get(link);
      if (!pending) {
        pending = fetchPaperMeta(link, apiKey);
        metaCache.set(link, pending);
        // A failure (rate limit, offline) is retried on the next hover.
        void pending.then((r) => !r.ok && metaCache.delete(link));
      }
      void pending.then((r) => alive && r.ok && setMeta(r.meta));
    }, metaCache.has(link) ? 0 : LOOKUP_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [link, apiKey]);
  return meta;
}

/** Add a cited paper to the library as to-read, in the first papers deck. */
async function saveToLibrary(meta: PaperMeta, deckId: string | undefined): Promise<string | null> {
  if (!deckId) {
    const res = await sendMessage({ type: 'FLASH_ADD_DECK', name: 'Papers', kind: 'papers' });
    if (!res.ok || !res.deck) return res.error ?? 'Could not create a deck.';
    deckId = res.deck.id;
  }
  const res = await sendMessage({
    type: 'PAPER_ADD',
    draft: {
      deckId,
      title: meta.title,
      authors: meta.authors,
      venue: meta.venue,
      year: meta.year,
      citations: meta.citations,
      url: meta.url,
      abstract: meta.abstract,
      relevance: '',
      status: 'to-read',
      progressPercent: 0,
      leftOff: '',
    },
  });
  return res.ok ? null : (res.error ?? 'Could not save.');
}

/** "A, B, C, D" → "A, B, C et al." */
function shortAuthors(authors: string): string {
  const list = authors.split(',').map((a) => a.trim()).filter(Boolean);
  return list.length > 3 ? `${list.slice(0, 3).join(', ')} et al.` : list.join(', ');
}

/** First couple of sentences: enough to tell what the paper is, short enough for a hover. */
function clipAbstract(text: string): string {
  if (text.length <= 280) return text;
  const cut = text.slice(0, 280);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

/** Where "Open" should go for a citation you already have. */
function localHref(target: KnownTarget): string {
  return target.path ? chrome.runtime.getURL(target.path) : target.externalUrl;
}

/** A short label for a link, e.g. "arXiv", "DOI", "Search", or the hostname. */
function linkLabel(ref: Reference): string {
  if (!ref.link) return 'Search';
  if (/arxiv\.org/i.test(ref.link)) return 'arXiv';
  if (/doi\.org/i.test(ref.link)) return 'DOI';
  try {
    return new URL(ref.link).hostname.replace(/^www\./i, '');
  } catch {
    return 'Open';
  }
}

/**
 * Hover preview for a citation marker: the bibliography entry text plus a link
 * to the paper. Fixed-positioned (viewport px) like SelectionMenu so it tracks
 * a marker across page boundaries and zoom. Reports enter/leave so the parent
 * can keep it open while the pointer moves from the marker into the tooltip.
 */
export function CitationTooltip({
  refs,
  known,
  x,
  y,
  flip,
  onEnter,
  onLeave,
}: {
  refs: Reference[];
  /** Citations resolving to something in the library, by match key */
  known: Map<string, KnownTarget>;
  x: number;
  y: number;
  /** Anchor below the marker (transform from the top) instead of above it. */
  flip: boolean;
  onEnter: () => void;
  onLeave: () => void;
}) {
  return (
    <div
      className="cite-tooltip"
      style={{
        left: x,
        top: y,
        transform: flip ? 'translate(-50%, 0)' : undefined,
        maxHeight: (flip ? window.innerHeight - y : y) - 12,
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {refs.map((ref, i) => (
        <CitationEntry key={i} entry={ref} mine={knownTargetFor(ref, known)} />
      ))}
    </div>
  );
}

function CitationEntry({ entry, mine }: { entry: Reference; mine: KnownTarget | null }) {
  const meta = useRefMeta(entry.link);
  const [decks] = useStorageValue('decks');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!meta) return;
    setSaving(true);
    setError(await saveToLibrary(meta, decks.find((d) => d.kind === 'papers')?.id));
    // On success the papers list updates and `mine` flips this to "In your papers".
    setSaving(false);
  };

  return (
    <div className="cite-tooltip-entry">
      {meta?.title ? (
        <div className="cite-tooltip-text">
          {entry.label !== null && <span className="cite-tooltip-label">[{entry.label}]</span>}
          <strong>{meta.title}</strong>
          <span className="cite-tooltip-byline">
            {[shortAuthors(meta.authors), meta.venue, meta.year].filter(Boolean).join(' · ')}
          </span>
          {meta.abstract && <span className="cite-tooltip-summary">{clipAbstract(meta.abstract)}</span>}
        </div>
      ) : (
        <div className="cite-tooltip-text">
          {entry.label !== null && <span className="cite-tooltip-label">[{entry.label}]</span>}
          {entry.text}
        </div>
      )}
      {/* A citation you already have opens your copy, with your
          highlights on it — not the publisher's page. */}
      {mine ? (
        <div className="cite-tooltip-mine">
          <span className="cite-tooltip-have">
            {mine.kind === 'paper' ? 'In your papers' : "You've read this"}
          </span>
          <a className="cite-tooltip-link" href={localHref(mine)}>
            Open
          </a>
        </div>
      ) : (
        <div className="cite-tooltip-mine">
          <a className="cite-tooltip-link" href={citationHref(entry)} target="_blank" rel="noreferrer">
            {linkLabel(entry)} ↗
          </a>
          {meta?.pdfUrl && (
            <a className="cite-tooltip-link" href={chrome.runtime.getURL(readerPagePath(meta.pdfUrl))}>
              Read PDF
            </a>
          )}
          {meta?.title && (
            <button type="button" className="cite-tooltip-save" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      )}
      {error && <span className="cite-tooltip-have">{error}</span>}
    </div>
  );
}
