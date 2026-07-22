import { NEWTAB_PAGE_PATH } from '../../../shared/constants';
import { sendMessage } from '../../../shared/messages';
import { useTheme } from '../../../shared/hooks/useTheme';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

export function ReaderToolbar({
  title,
  page,
  pageCount,
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
  askOpen,
  onToggleAsk,
}: {
  title: string;
  page: number;
  pageCount: number;
  /** What `page` counts — articles have blocks, not pages */
  pageNoun?: 'page' | 'block';
  /** Zoom is PDF-only; articles reflow with the browser's own zoom */
  zoom?: number;
  onZoom?: (zoom: number) => void;
  hasOutline: boolean;
  outlineOpen: boolean;
  onToggleOutline: () => void;
  /** The document URL, for the escape hatch out of the reader */
  src: string;
  openOriginalLabel?: string;
  noteMode: boolean;
  onToggleNoteMode: () => void;
  notesOpen: boolean;
  annotationCount: number;
  onToggleNotes: () => void;
  askOpen: boolean;
  onToggleAsk: () => void;
}) {
  const theme = useTheme();
  return (
    <header className="reader-toolbar">
      <div className="reader-toolbar-left">
        <button
          className="ghost-btn"
          onClick={() => {
            location.href = chrome.runtime.getURL(NEWTAB_PAGE_PATH);
          }}
        >
          ← Dashboard
        </button>
        {hasOutline && (
          <button className="ghost-btn" onClick={onToggleOutline}>
            {outlineOpen ? 'Hide outline' : 'Show outline'}
          </button>
        )}
        <h1 title={title}>{title}</h1>
      </div>
      <div className="reader-toolbar-right">
        {pageCount > 0 && (
          <span className="reader-pageno" title={`${pageNoun} ${page} of ${pageCount}`}>
            {page} / {pageCount}
          </span>
        )}
        {onZoom && zoom !== undefined && (
          <>
            <button
              className="ghost-btn"
              disabled={zoom <= ZOOM_MIN}
              onClick={() => onZoom(Math.max(ZOOM_MIN, Math.round((zoom - 0.25) * 100) / 100))}
            >
              −
            </button>
            <button
              className="ghost-btn"
              disabled={zoom >= ZOOM_MAX}
              onClick={() => onZoom(Math.min(ZOOM_MAX, Math.round((zoom + 0.25) * 100) / 100))}
            >
              ＋
            </button>
          </>
        )}
        <button
          className="ghost-btn fc-theme-toggle"
          title={theme.resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={() => theme.setMode(theme.resolved === 'dark' ? 'light' : 'dark')}
        >
          {theme.resolved === 'dark' ? 'Light' : 'Dark'}
        </button>
        <button
          className={noteMode ? 'ghost-btn active' : 'ghost-btn'}
          title="Drop a sticky note here"
          onClick={onToggleNoteMode}
        >
          Add note
        </button>
        <button
          className={notesOpen ? 'ghost-btn active' : 'ghost-btn'}
          title="Show highlights and notes"
          onClick={onToggleNotes}
        >
          Notes {annotationCount > 0 && `(${annotationCount})`}
        </button>
        <button
          className={askOpen ? 'ghost-btn active' : 'ghost-btn'}
          title="Ask questions about this document"
          onClick={onToggleAsk}
        >
          Ask
        </button>
        <button
          className="ghost-btn"
          title={
            openOriginalLabel === 'Open in Chrome'
              ? "Open this PDF in Chrome's built-in viewer instead"
              : 'Open the original page'
          }
          onClick={() =>
            openOriginalLabel === 'Open in Chrome'
              ? void sendMessage({ type: 'READER_OPEN_NATIVE', url: src })
              : void chrome.tabs.create({ url: src })
          }
        >
          {openOriginalLabel}
        </button>
      </div>
    </header>
  );
}
