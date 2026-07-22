import {
  ANNOTATION_SWATCH_COLORS,
  annotationOffset,
  annotationSeq,
} from '../../../shared/annotations';
import type { Annotation } from '../../../shared/types';

/**
 * Groups annotations (already sorted) by their sequence position — page for a
 * PDF, block index for an article. `labelFor` names the group; return '' and
 * the list renders flat, which is what articles want (block numbers mean
 * nothing to a reader).
 */
function groupBySeq(annotations: Annotation[]): [number, Annotation[]][] {
  const groups: [number, Annotation[]][] = [];
  for (const a of annotations) {
    const seq = annotationSeq(a);
    const last = groups[groups.length - 1];
    if (last && last[0] === seq) last[1].push(a);
    else groups.push([seq, [a]]);
  }
  return groups;
}

export function AnnotationsSidebar({
  annotations,
  labelFor,
  emptyHint,
  onJump,
  onDelete,
}: {
  /** Sorted (sortAnnotations), all belonging to the current document */
  annotations: Annotation[];
  /** Group heading for a sequence position; '' renders no heading */
  labelFor?: (seq: number) => string;
  emptyHint: string;
  onJump: (seq: number, offset: number) => void;
  onDelete: (id: string) => void;
}) {
  const groups = labelFor
    ? groupBySeq(annotations)
    : ([[0, annotations]] as [number, Annotation[]][]);

  return (
    <nav className="reader-notes">
      <h2>Notes</h2>
      {annotations.length === 0 && <p className="reader-notes-empty">{emptyHint}</p>}
      {groups.map(([seq, group]) => {
        const label = labelFor?.(seq) ?? '';
        return (
          <div key={seq}>
            {label && <h3>{label}</h3>}
            {group.map((a) => (
              <button
                key={a.id}
                className="annot-row"
                onClick={() => onJump(annotationSeq(a), annotationOffset(a))}
              >
                <span
                  className="annot-row-swatch"
                  style={{ background: ANNOTATION_SWATCH_COLORS[a.color] }}
                />
                <span className="annot-row-body">
                  <span className="annot-row-text">
                    {a.kind === 'highlight' ? a.text || '(highlight)' : a.note || 'Sticky note'}
                  </span>
                  {a.kind === 'highlight' && a.note && (
                    <span className="annot-row-note">{a.note}</span>
                  )}
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
        );
      })}
    </nav>
  );
}
