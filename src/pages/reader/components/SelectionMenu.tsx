import { ANNOTATION_SWATCH_COLORS } from '../../../shared/annotations';
import type { AnnotationColor, HighlightTag } from '../../../shared/types';
import { TAGS } from './ProvocationCard';

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
  mode = 'colors',
  onTag,
  onQuestion,
}: {
  /** Fixed-position anchor, viewport px (already clamped by the caller) */
  x: number;
  y: number;
  onPick: (color: AnnotationColor) => void;
  /** 'tags' (PDF): say what the passage is before highlighting it */
  mode?: 'colors' | 'tags';
  /** null = a plain, untagged highlight */
  onTag?: (tag: HighlightTag | null) => void;
  onQuestion?: () => void;
}) {
  if (mode === 'tags') {
    return (
      <div
        className="annot-selection-menu annot-tag-menu"
        style={{ left: x, top: y }}
        role="toolbar"
        aria-label="Highlight as"
        onPointerDown={(e) => e.preventDefault()}
      >
        {TAGS.map((t) => (
          <button key={t.tag} type="button" className="annot-tag-btn" onClick={() => onTag?.(t.tag)}>
            {t.label}
          </button>
        ))}
        <button type="button" className="annot-tag-btn" onClick={() => onTag?.(null)}>
          Highlight
        </button>
        <button type="button" className="annot-tag-btn annot-tag-question" onClick={onQuestion}>
          Question this
        </button>
      </div>
    );
  }
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
