import { ANNOTATION_SWATCH_COLORS, annotationOffset } from '../../../shared/annotations';
import type { PdfAnnotation } from '../../../shared/types';

/** Groups annotations (already sorted by page, offset) under a per-page heading. */
function groupByPage(annotations: PdfAnnotation[]): [number, PdfAnnotation[]][] {
  const groups: [number, PdfAnnotation[]][] = [];
  for (const a of annotations) {
    const last = groups[groups.length - 1];
    if (last && last[0] === a.page) last[1].push(a);
    else groups.push([a.page, [a]]);
  }
  return groups;
}

export function AnnotationsSidebar({
  annotations,
  onJump,
  onDelete,
}: {
  /** Sorted (sortAnnotations), all belonging to the current document */
  annotations: PdfAnnotation[];
  onJump: (page: number, offset: number) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <nav className="reader-notes">
      <h2>Notes</h2>
      {annotations.length === 0 && (
        <p className="reader-notes-empty">Select text in the PDF to highlight it.</p>
      )}
      {groupByPage(annotations).map(([page, group]) => (
        <div key={page}>
          <h3>Page {page}</h3>
          {group.map((a) => (
            <button
              key={a.id}
              className="annot-row"
              onClick={() => onJump(a.page, annotationOffset(a))}
            >
              <span
                className="annot-row-swatch"
                style={{ background: ANNOTATION_SWATCH_COLORS[a.color] }}
              />
              <span className="annot-row-body">
                <span className="annot-row-text">
                  {a.kind === 'highlight' ? a.text || '(highlight)' : a.note || 'Sticky note'}
                </span>
                {a.kind === 'highlight' && a.note && <span className="annot-row-note">{a.note}</span>}
              </span>
              <span
                className="annot-row-delete"
                role="button"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(a.id);
                }}
              >
                ×
              </span>
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}
