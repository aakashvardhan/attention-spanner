import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { nanoProvider } from '../../../shared/ai/nanoProvider';
import {
  getOrGeneratePdfOutline,
  pdfOutlineCacheKey,
  type AiOutlineItem,
} from '../../../shared/ai/pdfOutline';
import { DEFAULT_SETTINGS } from '../../../shared/storage';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import type { FlatOutlineItem } from '../../../shared/pdfOutline';

export function AiOutlinePanel({
  title,
  pageTexts,
  bookmarks,
  onJump,
  onClose,
  embedded = false,
}: {
  title: string;
  pageTexts: string[] | null;
  bookmarks: FlatOutlineItem[];
  onJump: (page: number) => void;
  onClose?: () => void;
  embedded?: boolean;
}) {
  const [storedSettings, settingsLoaded] = useStorageValue('settings');
  const settings = useMemo(
    () => ({ ...DEFAULT_SETTINGS, ...storedSettings }),
    [storedSettings],
  );
  const [nanoOk, setNanoOk] = useState(false);
  const [providerChecked, setProviderChecked] = useState(false);
  const [items, setItems] = useState<AiOutlineItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cached, setCached] = useState(false);
  const requestId = useRef(0);
  const hasExtractableText =
    pageTexts !== null && pageTexts.join('').replace(/\s/g, '').length >= 200;
  const contentKey = hasExtractableText ? pdfOutlineCacheKey(pageTexts) : '';

  useEffect(() => {
    let alive = true;
    void nanoProvider.available()
      .then((available) => alive && setNanoOk(available))
      .catch(() => alive && setNanoOk(false))
      .finally(() => alive && setProviderChecked(true));
    return () => { alive = false; };
  }, []);

  const generate = useCallback(async (force = false) => {
    if (!pageTexts?.length) return;
    const id = ++requestId.current;
    setBusy(true);
    setError('');
    try {
      const result = await getOrGeneratePdfOutline(
        { title, pageTexts, bookmarks, settings, nanoOk },
        force,
      );
      if (requestId.current !== id) return;
      setItems(result.items);
      setCached(result.cached);
    } catch (err) {
      if (requestId.current !== id) return;
      setError((err as Error).message || 'Could not create an outline.');
    } finally {
      if (requestId.current === id) setBusy(false);
    }
  }, [title, contentKey, bookmarks, settings, nanoOk]);

  // Reset between documents, then start as soon as PDF text and provider
  // availability are known. The content-addressed cache is checked first.
  useEffect(() => {
    setItems(null);
    setCached(false);
    setError('');
  }, [contentKey]);
  useEffect(() => {
    if (!contentKey || !settingsLoaded || !providerChecked) return;
    void generate();
  }, [contentKey, settingsLoaded, providerChecked, generate]);

  const content = <>
    {!embedded && <div className="reader-related-head"><h2>AI outline</h2><button className="ghost-btn" onClick={onClose} aria-label="Close AI outline">✕</button></div>}
    <div className="ai-outline-trust">
      <span aria-hidden="true">✦</span>
      <p><strong>Grounded in this paper</strong><small>Headings and passages are verified against the PDF text.</small></p>
    </div>
    {(pageTexts === null || busy) && !items && (
      <div className="ai-outline-loading" role="status" aria-live="polite">
        <span className="reader-loading-spinner" aria-hidden="true" />
        <p>{pageTexts === null ? 'Reading paper text…' : 'Building a source-verified outline…'}</p>
      </div>
    )}
    {pageTexts !== null && !hasExtractableText && (
      <div className="ai-outline-error" role="status">
        <p>This PDF does not contain enough extractable text to build a verified outline. OCR may be required.</p>
      </div>
    )}
    {error && !items && (
      <div className="ai-outline-error" role="alert">
        <p>{error}</p>
        <button type="button" onClick={() => void generate(true)}>Try again</button>
      </div>
    )}
    {items && (
      <>
        <div className="ai-outline-meta" role="status">
          <span>{cached ? 'Loaded from saved outline' : 'Outline ready'}</span>
          <button type="button" disabled={busy} onClick={() => void generate(true)} aria-label="Regenerate AI outline">
            {busy ? 'Updating…' : 'Regenerate'}
          </button>
        </div>
        <ol className="ai-outline-list">
          {items.map((item, i) => (
            <li key={`${item.page}:${item.level}:${i}`} style={{ '--outline-depth': item.level } as CSSProperties}>
              <button type="button" onClick={() => onJump(item.page)} aria-label={`${item.title}, page ${item.page}`}>
                <span className="ai-outline-number" aria-hidden="true">{i + 1}</span>
                <span className="ai-outline-copy">
                  <strong>{item.title}</strong>
                  <span>{item.summary}</span>
                  <em>Page {item.page} · From paper</em>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </>
    )}
  </>;
  return embedded ? <div className="ai-outline-embedded">{content}</div> : <aside className="reader-ai-outline" aria-label="AI outline">{content}</aside>;
}
