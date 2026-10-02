import { ANNOTATION_SWATCH_COLORS } from '../../../shared/annotations';
import type { AnnotationColor } from '../../../shared/types';

const COLORS = Object.keys(ANNOTATION_SWATCH_COLORS) as AnnotationColor[];

/**
 * Floating pill shown above an active text selection: pick a highlight colour,
 * or turn the selection straight into a flashcard. The card action closes the
 * loop between reading and retention — highlights, decks and the SRS scheduler
 * all existed already, with nothing connecting them.
 */
export function SelectionMenu({
  x,
  y,
  onPick,
}: {
  /** Fixed-position anchor, viewport px (already clamped by the caller) */
  x: number;
  y: number;
  onPick: (color: AnnotationColor) => void;
}) {
  return (
    <div
      className="annot-selection-menu"
      style={{ left: x, top: y }}
      // Selection collapses on pointerdown outside the pill; keep it alive here.
      onPointerDown={(e) => e.preventDefault()}
    >
      {COLORS.map((color) => (
        <button
          key={color}
          className="annot-swatch"
          style={{ background: ANNOTATION_SWATCH_COLORS[color] }}
          title={`Highlight in ${color}`}
          onClick={() => onPick(color)}
        />
      ))}
    </div>
  );
}
