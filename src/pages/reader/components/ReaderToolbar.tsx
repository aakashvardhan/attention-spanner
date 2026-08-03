import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NEWTAB_PAGE_PATH } from '../../../shared/constants';
import { sendMessage } from '../../../shared/messages';
import { useTheme } from '../../../shared/hooks/useTheme';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

function ToolbarIcon({
  children,
  viewBox = '0 0 24 24',
}: {
  children: ReactNode;
  viewBox?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className="reader-toolbar-icon"
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function ReaderToolbar({
  title,
  page,
  pageCount,
  pageNoun = 'page',
  onPageJump,
  zoom,
  onZoom,
  hasOutline,
  outlineOpen,
  onToggleOutline,
  src,
  openOriginalLabel = "Open in Chrome",
  noteMode,
  onToggleNoteMode,
  notesOpen,
  annotationCount,
  onToggleNotes,
  askOpen,
  onToggleAsk,
  relatedOpen,
  onToggleRelated,
  findOpen,
  onToggleFind,
  aiOutlineOpen,
  onToggleAiOutline,
  actionItemsCount,
  actionsOpen,
  onToggleActions,
}: {
  title: string;
  page: number;
  pageCount: number;
  /** What `page` counts — articles have blocks, not pages */
  pageNoun?: 'page' | 'block';
  onPageJump?: (page: number) => void;
  /** Zoom is PDF-only; articles reflow with the browser's own zoom */
  zoom?: number;
  onZoom?: (zoom: number) => void;
  hasOutline: boolean;
  outlineOpen: boolean;
  onToggleOutline: () => void;
  /** The document URL, for the escape hatch out of the reader */
  /** The document's own URL; absent for documents with no original (a mic recording) */
  src?: string;
  openOriginalLabel?: string;
  noteMode: boolean;
  onToggleNoteMode: () => void;
  notesOpen: boolean;
  annotationCount: number;
  onToggleNotes: () => void;
  askOpen: boolean;
  onToggleAsk: () => void;
  /** Absent for documents with no reference list to relate (a recording) */
  relatedOpen?: boolean;
  onToggleRelated?: () => void;
  findOpen?: boolean;
  onToggleFind?: () => void;
  aiOutlineOpen?: boolean;
  onToggleAiOutline?: () => void;
  /** Recording-only action item popup. */
  actionItemsCount?: number;
  actionsOpen?: boolean;
  onToggleActions?: () => void;
}) {
  const theme = useTheme();
  const [pageDraft, setPageDraft] = useState(String(page));
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  // Scroll position changes the current page; keep the editable control in
  // sync without preventing someone from typing a multi-digit target.
  useEffect(() => setPageDraft(String(page)), [page]);

  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [moreOpen]);

  // Reader-level shortcuts mirror familiar Preview/browser conventions while
  // keeping browser zoom from changing the extension chrome around the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'f' && onToggleFind) {
        event.preventDefault();
        if (!findOpen) onToggleFind();
        return;
      }
      if (!onZoom || zoom === undefined) return;
      if (key === '=' || key === '+') {
        event.preventDefault();
        onZoom(Math.min(ZOOM_MAX, Math.round((zoom + 0.25) * 100) / 100));
      } else if (key === '-') {
        event.preventDefault();
        onZoom(Math.max(ZOOM_MIN, Math.round((zoom - 0.25) * 100) / 100));
      } else if (key === '0') {
        event.preventDefault();
        onZoom(1);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [findOpen, onToggleFind, onZoom, zoom]);

  const jumpToDraft = () => {
    const next = Number(pageDraft);
    if (onPageJump && Number.isInteger(next) && next >= 1 && next <= pageCount) {
      onPageJump(next);
    } else {
      setPageDraft(String(page));
    }
  };

  const closeAfter = (action: () => void) => {
    action();
    setMoreOpen(false);
  };

  return (
    <header className="reader-toolbar">
      <div className="reader-toolbar-left">
        <button
          className="reader-icon-btn"
          aria-label="Back to Dashboard"
          title="Back to Dashboard"
          onClick={() => {
            location.href = chrome.runtime.getURL(NEWTAB_PAGE_PATH);
          }}
        >
          <ToolbarIcon>
            <path d="m15 18-6-6 6-6" />
          </ToolbarIcon>
        </button>
        {hasOutline && (
          <button
            className={outlineOpen ? 'reader-icon-btn active' : 'reader-icon-btn'}
            aria-label={outlineOpen ? 'Hide sidebar' : 'Show sidebar'}
            aria-pressed={outlineOpen}
            title={outlineOpen ? 'Hide sidebar' : 'Show sidebar'}
            onClick={onToggleOutline}
          >
            <ToolbarIcon>
              <rect x="3.5" y="4" width="17" height="16" rx="2" />
              <path d="M9 4v16" />
            </ToolbarIcon>
          </button>
        )}
        <div className="reader-document-title">
          <h1 title={title}>{title}</h1>
          <span>{pageNoun === 'page' ? 'PDF document' : 'Reader'}</span>
        </div>
      </div>

      <div className="reader-toolbar-center">
        {pageCount > 0 && (
          onPageJump ? (
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
          ) : (
            <span className="reader-pageno" title={`${pageNoun} ${page} of ${pageCount}`}>
              {page} of {pageCount}
            </span>
          ))}
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
            <button
              className="reader-zoom-value"
              title="Fit width (⌘0)"
              onClick={() => onZoom(1)}
            >
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
      </div>

      <div className="reader-toolbar-right">
        {onToggleFind && (
          <button
            className={findOpen ? 'reader-icon-btn active' : 'reader-icon-btn'}
            aria-label="Find in document"
            aria-pressed={findOpen}
            title="Find in document (⌘F)"
            onClick={onToggleFind}
          >
            <ToolbarIcon>
              <circle cx="11" cy="11" r="6.5" />
              <path d="m16 16 4 4" />
            </ToolbarIcon>
          </button>
        )}
        <button
          className={noteMode ? 'reader-icon-btn active' : 'reader-icon-btn'}
          aria-label={noteMode ? 'Cancel note placement' : 'Add a note'}
          aria-pressed={noteMode}
          title={noteMode ? 'Cancel note placement (Esc)' : 'Add a note'}
          onClick={onToggleNoteMode}
        >
          <ToolbarIcon>
            <path d="M5 4.5h10a2 2 0 0 1 2 2V14l-5 5H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z" />
            <path d="M12 19v-3a2 2 0 0 1 2-2h3M8 9h4M10 7v4" />
          </ToolbarIcon>
        </button>
        <button
          className={notesOpen ? 'reader-icon-btn active reader-badged-btn' : 'reader-icon-btn reader-badged-btn'}
          aria-label={`Show highlights and notes${annotationCount ? `, ${annotationCount}` : ''}`}
          aria-pressed={notesOpen}
          title="Show highlights and notes"
          onClick={onToggleNotes}
        >
          <ToolbarIcon>
            <path d="M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 3v-14a2 2 0 0 1 2-2Z" />
            <path d="M8 9h8M8 13h6" />
          </ToolbarIcon>
          {annotationCount > 0 && <span className="reader-toolbar-badge">{annotationCount}</span>}
        </button>
        {onToggleActions && actionItemsCount !== undefined && actionItemsCount > 0 && (
          <button
            className={actionsOpen ? 'reader-icon-btn active reader-badged-btn' : 'reader-icon-btn reader-badged-btn'}
            aria-label={`Review ${actionItemsCount} suggested action items`}
            aria-pressed={actionsOpen}
            title="Review suggested action items"
            onClick={onToggleActions}
          >
            <ToolbarIcon>
              <path d="M6 21V4M6 5h10l-2.5 3L16 11H6" />
            </ToolbarIcon>
            <span className="reader-toolbar-badge">{actionItemsCount}</span>
          </button>
        )}
        <button
          className={askOpen ? 'reader-ask-btn active' : 'reader-ask-btn'}
          aria-pressed={askOpen}
          title="Ask questions about this document"
          onClick={onToggleAsk}
        >
          <ToolbarIcon>
            <path d="m12 3 .75 2.25L15 6l-2.25.75L12 9l-.75-2.25L9 6l2.25-.75L12 3Z" />
            <path d="m18 11 .55 1.45L20 13l-1.45.55L18 15l-.55-1.45L16 13l1.45-.55L18 11Z" />
            <path d="M4 9.5h3M4 13h7M4 16.5h9" />
          </ToolbarIcon>
          Ask
        </button>

        <div className="reader-more" ref={moreRef}>
          <button
            className={moreOpen ? 'reader-icon-btn active' : 'reader-icon-btn'}
            aria-label="More reader options"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            title="More reader options"
            onClick={() => setMoreOpen((open) => !open)}
          >
            <ToolbarIcon>
              <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
              <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
              <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
            </ToolbarIcon>
          </button>
          {moreOpen && (
            <div className="reader-more-menu" role="menu">
              {onToggleRelated && (
                <button
                  className={relatedOpen ? 'active' : ''}
                  role="menuitemcheckbox"
                  aria-checked={relatedOpen}
                  onClick={() => closeAfter(onToggleRelated)}
                >
                  <ToolbarIcon>
                    <circle cx="7" cy="12" r="3" />
                    <circle cx="17" cy="7" r="3" />
                    <circle cx="17" cy="17" r="3" />
                    <path d="m9.7 10.6 4.6-2.2M9.7 13.4l4.6 2.2" />
                  </ToolbarIcon>
                  <span>Related papers</span>
                  {relatedOpen && <span className="reader-menu-check">✓</span>}
                </button>
              )}
              {onToggleAiOutline && (
                <button
                  className={aiOutlineOpen ? 'active' : ''}
                  role="menuitemcheckbox"
                  aria-checked={aiOutlineOpen}
                  onClick={() => closeAfter(onToggleAiOutline)}
                >
                  <ToolbarIcon>
                    <path d="M4 7h10M4 12h16M4 17h12" />
                    <path d="m18 3 .45 1.55L20 5l-1.55.45L18 7l-.45-1.55L16 5l1.55-.45L18 3Z" />
                  </ToolbarIcon>
                  <span>AI outline</span>
                  {aiOutlineOpen && <span className="reader-menu-check">✓</span>}
                </button>
              )}
              <button
                role="menuitem"
                onClick={() =>
                  closeAfter(() => theme.setMode(theme.resolved === 'dark' ? 'light' : 'dark'))
                }
              >
                <ToolbarIcon>
                  {theme.resolved === 'dark' ? (
                    <>
                      <circle cx="12" cy="12" r="4" />
                      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                    </>
                  ) : (
                    <path d="M20.4 15.2A8 8 0 0 1 8.8 3.6 8.5 8.5 0 1 0 20.4 15.2Z" />
                  )}
                </ToolbarIcon>
                <span>{theme.resolved === 'dark' ? 'Light appearance' : 'Dark appearance'}</span>
              </button>
              {src && (
                <>
                  <div className="reader-menu-separator" role="separator" />
                  <button
                    role="menuitem"
                    onClick={() =>
                      closeAfter(() => {
                        if (openOriginalLabel === 'Open in Chrome') {
                          void sendMessage({ type: 'READER_OPEN_NATIVE', url: src });
                        } else {
                          void chrome.tabs.create({ url: src });
                        }
                      })
                    }
                  >
                    <ToolbarIcon>
                      <path d="M14 4h6v6M20 4l-9 9" />
                      <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
                    </ToolbarIcon>
                    <span>{openOriginalLabel}</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
