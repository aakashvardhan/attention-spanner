import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ToolbarIcon, ZOOM_MAX, ZOOM_MIN } from './ReaderToolbar';

/**
 * Where you are and how long is left, floating under the page. Click to open
 * page jump and zoom in place; Escape folds it back. It also carries the
 * reader's quiet announcements (a section finished, "you were here"), which
 * replace the summary for a few seconds and then give it back.
 *
 * The thin line across the top edge is the same number as a picture: how far
 * through the whole document you are.
 */
export function ReaderCapsule({
  label,
  progress,
  page,
  pageCount,
  pageNoun,
  onPageJump,
  zoom,
  onZoom,
  message = null,
  action = null,
  children,
}: {
  label: string;
  /** 0–1 through the whole document */
  progress: number;
  page: number;
  pageCount: number;
  /** What `page` counts — articles have blocks, not pages */
  pageNoun: 'page' | 'block';
  onPageJump?: (page: number) => void;
  /** Zoom is PDF-only; articles reflow with the browser's own zoom */
  zoom?: number;
  onZoom?: (zoom: number) => void;
  message?: string | null;
  action?: { label: string; run: () => void } | null;
  /** The tracking chip, when the document is not tracked yet */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pageDraft, setPageDraft] = useState(String(page));

  // Scroll position changes the current page; keep the editable control in
  // sync without preventing someone from typing a multi-digit target.
  useEffect(() => setPageDraft(String(page)), [page]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  const jumpToDraft = () => {
    const next = Number(pageDraft);
    if (onPageJump && Number.isInteger(next) && next >= 1 && next <= pageCount) {
      onPageJump(next);
    } else {
      setPageDraft(String(page));
    }
  };

  return (
    <>
      <div
        className="reader-progress-line"
        style={{ transform: `scaleX(${Math.min(1, Math.max(0, progress))})` }}
        aria-hidden="true"
      />
      <div
        ref={ref}
        className="reader-capsule"
        data-open={open || undefined}
        data-message={message ? '' : undefined}
      >
        {/* Always mounted, so a message arriving later is announced. */}
        <span className="reader-capsule-message" role="status" aria-live="polite">
          {message ?? ''}
        </span>
        {message ? (
          <>
            {action && (
              <button type="button" className="reader-capsule-action" onClick={action.run}>
                {action.label}
              </button>
            )}
          </>
        ) : open ? (
          <>
            {pageCount > 0 && onPageJump && (
              <div className="reader-toolbar-group reader-pagination" aria-label="Page navigation">
                <button
                  className="reader-icon-btn"
                  aria-label={`Previous ${pageNoun}`}
                  title={`Previous ${pageNoun}`}
                  disabled={page <= 1}
                  onClick={() => onPageJump(page - 1)}
                >
                  <ToolbarIcon>
                    <path d="m14 17-5-5 5-5" />
                  </ToolbarIcon>
                </button>
                <label className="reader-page-jump" title={`Go to ${pageNoun}`}>
                  <input
                    aria-label={`Go to ${pageNoun}`}
                    inputMode="numeric"
                    value={pageDraft}
                    onChange={(e) => setPageDraft(e.target.value)}
                    onBlur={jumpToDraft}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.currentTarget.blur();
                      } else if (e.key === 'Escape') {
                        setPageDraft(String(page));
                        e.currentTarget.blur();
                      }
                    }}
                  />
                  <span>of {pageCount}</span>
                </label>
                <button
                  className="reader-icon-btn"
                  aria-label={`Next ${pageNoun}`}
                  title={`Next ${pageNoun}`}
                  disabled={page >= pageCount}
                  onClick={() => onPageJump(page + 1)}
                >
                  <ToolbarIcon>
                    <path d="m10 17 5-5-5-5" />
                  </ToolbarIcon>
                </button>
              </div>
            )}
            {onZoom && zoom !== undefined && (
              <div className="reader-toolbar-group reader-zoom-controls" aria-label="Zoom controls">
                <button
                  className="reader-icon-btn"
                  aria-label="Zoom out"
                  title="Zoom out (⌘−)"
                  disabled={zoom <= ZOOM_MIN}
                  onClick={() => onZoom(Math.max(ZOOM_MIN, Math.round((zoom - 0.25) * 100) / 100))}
                >
                  <ToolbarIcon>
                    <path d="M7 12h10" />
                  </ToolbarIcon>
                </button>
                <button className="reader-zoom-value" title="Fit width (⌘0)" onClick={() => onZoom(1)}>
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  className="reader-icon-btn"
                  aria-label="Zoom in"
                  title="Zoom in (⌘+)"
                  disabled={zoom >= ZOOM_MAX}
                  onClick={() => onZoom(Math.min(ZOOM_MAX, Math.round((zoom + 0.25) * 100) / 100))}
                >
                  <ToolbarIcon>
                    <path d="M12 7v10M7 12h10" />
                  </ToolbarIcon>
                </button>
              </div>
            )}
          </>
        ) : (
          <button
            type="button"
            className="reader-capsule-summary"
            aria-expanded={false}
            aria-label={`${label}. Open page and zoom controls`}
            onClick={() => setOpen(true)}
          >
            <span className="reader-capsule-dot" aria-hidden="true" />
            {label}
          </button>
        )}
        {children}
      </div>
    </>
  );
}
