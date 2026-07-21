import { useEffect, useRef, useState } from 'react';
import { ANNOTATION_COLORS, ANNOTATION_SWATCH_COLORS } from '../../../shared/annotations';
import type { AnnotationColor, PdfAnnotation } from '../../../shared/types';

const COLORS = Object.keys(ANNOTATION_SWATCH_COLORS) as AnnotationColor[];

/**
 * Highlights, sticky pins, and the note-mode click target for one page. The
 * note popover for the active annotation (if it belongs to this page) renders
 * inside the same percent-positioned layer so it tracks zoom with everything
 * else.
 */
export function AnnotationLayer({
  annotations,
  activeId,
  onActivate,
  noteMode,
  onPlaceSticky,
  onUpdateNote,
  onUpdateColor,
  onDelete,
}: {
  annotations: PdfAnnotation[];
  activeId: string | null;
  onActivate: (id: string | null) => void;
  noteMode: boolean;
  onPlaceSticky: (x: number, y: number) => void;
  onUpdateNote: (id: string, note: string) => void;
  onUpdateColor: (id: string, color: AnnotationColor) => void;
  onDelete: (id: string) => void;
}) {
  const active = annotations.find((a) => a.id === activeId) ?? null;

  return (
    <div
      className={noteMode ? 'annot-layer note-mode' : 'annot-layer'}
      onClick={(e) => {
        if (!noteMode) return;
        const rect = e.currentTarget.getBoundingClientRect();
        onPlaceSticky((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
      }}
    >
      {annotations.map((a) =>
        a.kind === 'highlight'
          ? a.rects.map((r, i) => (
              <div
                key={`${a.id}-${i}`}
                // The note affordance dot sits on the last rect only, so a
                // multi-line highlight shows one dot, not one per line.
                className={a.note && i === a.rects.length - 1 ? 'annot-highlight annot-has-note' : 'annot-highlight'}
                style={{
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.w * 100}%`,
                  height: `${r.h * 100}%`,
                  background: ANNOTATION_COLORS[a.color],
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onActivate(a.id);
                }}
              />
            ))
          : (
              <div
                key={a.id}
                className="annot-pin"
                style={{
                  left: `${a.x * 100}%`,
                  top: `${a.y * 100}%`,
                  background: ANNOTATION_SWATCH_COLORS[a.color],
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onActivate(a.id);
                }}
              />
            ),
      )}
      {active && (
        <NotePopover
          annotation={active}
          onUpdateNote={(note) => onUpdateNote(active.id, note)}
          onUpdateColor={(color) => onUpdateColor(active.id, color)}
          onDelete={() => {
            onDelete(active.id);
            onActivate(null);
          }}
          onClose={() => onActivate(null)}
        />
      )}
    </div>
  );
}

function NotePopover({
  annotation,
  onUpdateNote,
  onUpdateColor,
  onDelete,
  onClose,
}: {
  annotation: PdfAnnotation;
  onUpdateNote: (note: string) => void;
  onUpdateColor: (color: AnnotationColor) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState(annotation.note);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Refs so commit-on-unmount reads the latest values (the closing click
  // unmounts this popover before a textarea blur can fire — see below).
  const noteRef = useRef(annotation.note);
  const committedRef = useRef(annotation.note);

  useEffect(() => {
    setNote(annotation.note);
    noteRef.current = annotation.note;
    committedRef.current = annotation.note;
  }, [annotation.id, annotation.note]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [annotation.id]);

  const changeNote = (value: string) => {
    noteRef.current = value;
    setNote(value);
  };

  const commit = () => {
    if (noteRef.current !== committedRef.current) {
      committedRef.current = noteRef.current;
      onUpdateNote(noteRef.current);
    }
  };

  // The document pointerdown-outside handler closes (unmounts) the popover on
  // the same click that would blur the textarea, so onBlur alone loses the
  // edit. Flush on unmount as the reliable path; onBlur covers focus moves
  // that don't unmount (e.g. tabbing to a swatch).
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => commitRef.current(), []);

  // Anchor just below the annotation: the top-left rect for a highlight, the
  // pin position for a sticky note.
  const anchor =
    annotation.kind === 'highlight' && annotation.rects.length
      ? { left: annotation.rects[0].x, top: annotation.rects[0].y + annotation.rects[0].h }
      : { left: annotation.x, top: annotation.y };

  return (
    <div
      className="annot-popover"
      style={{ left: `${anchor.left * 100}%`, top: `${anchor.top * 100}%` }}
      onClick={(e) => e.stopPropagation()}
    >
      {annotation.kind === 'highlight' && annotation.text && (
        <div className="annot-popover-snippet">{annotation.text}</div>
      )}
      <textarea
        ref={textareaRef}
        value={note}
        placeholder="Add a note…"
        onChange={(e) => changeNote(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            commit();
            onClose();
          } else if (e.key === 'Escape') {
            onClose();
          }
        }}
      />
      <div className="annot-popover-actions">
        {COLORS.map((color) => (
          <button
            key={color}
            className={color === annotation.color ? 'annot-swatch active' : 'annot-swatch'}
            style={{ background: ANNOTATION_SWATCH_COLORS[color] }}
            title={color}
            onClick={() => onUpdateColor(color)}
          />
        ))}
        <button className="ghost-btn annot-delete" onClick={onDelete}>
          Delete
        </button>
        <button className="ghost-btn" onClick={() => { commit(); onClose(); }}>
          ×
        </button>
      </div>
    </div>
  );
}
