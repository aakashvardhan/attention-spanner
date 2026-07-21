import { citationHref, type Reference } from '../references';

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
  x,
  y,
  flip,
  onEnter,
  onLeave,
}: {
  refs: Reference[];
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
      style={{ left: x, top: y, transform: flip ? 'translate(-50%, 0)' : undefined }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {refs.map((ref, i) => (
        <div key={i} className="cite-tooltip-entry">
          <div className="cite-tooltip-text">
            {ref.label !== null && <span className="cite-tooltip-label">[{ref.label}]</span>}
            {ref.text}
          </div>
          <a className="cite-tooltip-link" href={citationHref(ref)} target="_blank" rel="noreferrer">
            {linkLabel(ref)} ↗
          </a>
        </div>
      ))}
    </div>
  );
}
