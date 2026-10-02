import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatCitation, type CiteSource, type CiteStyle } from '../../../shared/citeFormats';
import { NEWTAB_PAGE_PATH } from '../../../shared/constants';
import { sendMessage } from '../../../shared/messages';
import { useSettings } from '../../../shared/hooks/useSettings';
import { useTheme } from '../../../shared/hooks/useTheme';
import { patchSettings } from '../../../shared/storage';

const CITE_STYLES: [CiteStyle, string][] = [
  ['apa', 'APA'],
  ['mla', 'MLA'],
  ['bibtex', 'BibTeX'],
];

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;

export function ToolbarIcon({
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
  pageNoun = 'page',
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
  findOpen,
  onToggleFind,
  askOpen,
  onToggleAsk,
  citation,
}: {
  title: string;
  /** Articles have blocks, not pages; night mode is PDF-only */
  pageNoun?: 'page' | 'block';
  /** Zoom shortcuts (⌘+/−/0) are PDF-only; the controls live in the capsule */
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
  /** Absent for documents with no reference list to relate (a recording) */
  findOpen?: boolean;
  onToggleFind?: () => void;
  askOpen?: boolean;
  onToggleAsk?: () => void;
  /** What "Copy citation" formats (may look it up); absent where there is nothing to cite */
  citation?: () => Promise<CiteSource>;
}) {
  const theme = useTheme();
  const [settings] = useSettings();
  // Night only exists for PDFs: it inverts the rendered pages.
  const night = pageNoun === 'page' && settings.readerNight && theme.resolved === 'dark';
  const appearance = night ? 'night' : theme.resolved;
  // One patch: two concurrent read-modify-writes of settings would drop one.
  const setAppearance = (mode: 'light' | 'dark' | 'night') =>
    void patchSettings({ theme: mode === 'light' ? 'light' : 'dark', readerNight: mode === 'night' });
  const [copied, setCopied] = useState<{ style: CiteStyle; label: string } | null>(null);
  const copyCitation = async (style: CiteStyle) => {
    if (!citation) return;
    const flash = (label: string) => {
      setCopied({ style, label });
      setTimeout(() => setCopied((c) => (c?.style === style ? null : c)), 1500);
    };
    setCopied({ style, label: 'Looking up…' });
    try {
      await navigator.clipboard.writeText(formatCitation(await citation(), style));
      flash('Copied');
    } catch {
      flash('Copy failed');
    }
  };
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

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

      <div className="reader-toolbar-right">
        {onToggleAsk && (
          <button
            className={askOpen ? 'reader-icon-btn active' : 'reader-icon-btn'}
            aria-label="Ask this document"
            aria-pressed={askOpen}
            title="Ask this document"
            onClick={onToggleAsk}
          >
            <ToolbarIcon>
              <path d="M12 20.5a8.5 8.5 0 1 0-7.6-4.7L3.5 20.5l4.7-.9A8.46 8.46 0 0 0 12 20.5Z" />
              <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.3M12 16.4v.1" />
            </ToolbarIcon>
          </button>
        )}
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
              <button
                role="menuitemradio"
                aria-checked={appearance === 'light'}
                className={appearance === 'light' ? 'active' : undefined}
                onClick={() => closeAfter(() => setAppearance('light'))}
              >
                <ToolbarIcon>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                </ToolbarIcon>
                <span>Light</span>
              </button>
              <button
                role="menuitemradio"
                aria-checked={appearance === 'dark'}
                className={appearance === 'dark' ? 'active' : undefined}
                onClick={() => closeAfter(() => setAppearance('dark'))}
              >
                <ToolbarIcon>
                  <path d="M20.4 15.2A8 8 0 0 1 8.8 3.6 8.5 8.5 0 1 0 20.4 15.2Z" />
                </ToolbarIcon>
                <span>Dark</span>
              </button>
              {pageNoun === 'page' && (
                <button
                  role="menuitemradio"
                  aria-checked={appearance === 'night'}
                  className={appearance === 'night' ? 'active' : undefined}
                  title="Dark pages too: the PDF's colors are inverted"
                  onClick={() => closeAfter(() => setAppearance('night'))}
                >
                  <ToolbarIcon>
                    <path d="M20.4 15.2A8 8 0 0 1 8.8 3.6 8.5 8.5 0 1 0 20.4 15.2Z" />
                    <path d="M17 3v4M15 5h4" />
                  </ToolbarIcon>
                  <span>Night</span>
                </button>
              )}
              {citation && (
                <>
                  <div className="reader-menu-separator" role="separator" />
                  {CITE_STYLES.map(([style, label]) => (
                    <button key={style} role="menuitem" onClick={() => void copyCitation(style)}>
                      <ToolbarIcon>
                        <rect x="8" y="8" width="12" height="12" rx="2" />
                        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                      </ToolbarIcon>
                      <span>{copied?.style === style ? copied.label : `Copy ${label} citation`}</span>
                    </button>
                  ))}
                </>
              )}
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
