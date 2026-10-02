import { ANNOTATION_TEXT_MAX_CHARS, MAX_ANNOTATIONS } from '../shared/constants';
import { getLocal, setLocal } from '../shared/storage';
import type { Annotation, AnnotationDraft } from '../shared/types';

/**
 * All annotation writes happen here in the service worker so the reader page
 * and any future surfaces never race each other.
 */

export type AnnotationResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

/** A draft is only usable if its anchor can actually locate something. */
function anchorProblem(draft: AnnotationDraft): string | null {
  if (draft.anchor.kind === 'pdf') {
    if (draft.anchor.page < 1) return 'Invalid page number.';
    if (draft.kind === 'highlight' && draft.anchor.rects.length === 0) {
      return 'Highlight has no selection rects.';
    }
    return null;
  }
  if (draft.anchor.blockIndex < 0) return 'Invalid block index.';
  if (draft.kind === 'highlight' && !draft.anchor.quote.trim()) {
    return 'Highlight has no quoted text.';
  }
  return null;
}

export async function addAnnotation(
  draft: AnnotationDraft,
): Promise<AnnotationResult<{ annotation: Annotation }>> {
  if (!draft.docKey) return { ok: false, error: 'Annotation has no document key.' };
  const problem = anchorProblem(draft);
  if (problem) return { ok: false, error: problem };

  const { annotations } = await getLocal('annotations');
  if (annotations.length >= MAX_ANNOTATIONS) {
    return { ok: false, error: `Annotation limit reached (${MAX_ANNOTATIONS}).` };
  }
  const now = Date.now();
  const annotation: Annotation = {
    ...draft,
    text: draft.text.slice(0, ANNOTATION_TEXT_MAX_CHARS),
    note: draft.note.slice(0, ANNOTATION_TEXT_MAX_CHARS),
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  await setLocal({ annotations: [...annotations, annotation] });
  return { ok: true, annotation };
}

export async function updateAnnotation(
  id: string,
  patch: Partial<Pick<Annotation, 'note' | 'color'>>,
): Promise<AnnotationResult> {
  const { annotations } = await getLocal('annotations');
  const annotation = annotations.find((a) => a.id === id);
  if (!annotation) return { ok: false, error: 'Annotation not found.' };
  Object.assign(annotation, patch);
  if (annotation.note.length > ANNOTATION_TEXT_MAX_CHARS) {
    annotation.note = annotation.note.slice(0, ANNOTATION_TEXT_MAX_CHARS);
  }
  annotation.updatedAt = Date.now();
  await setLocal({ annotations });
  return { ok: true };
}

/** Move a sticky pin. PDF-anchored only — text stickies ride their quote. */
export async function moveAnnotation(id: string, x: number, y: number): Promise<AnnotationResult> {
  const { annotations } = await getLocal('annotations');
  const annotation = annotations.find((a) => a.id === id);
  if (!annotation) return { ok: false, error: 'Annotation not found.' };
  if (annotation.anchor.kind !== 'pdf') return { ok: false, error: 'Not a positioned annotation.' };
  annotation.anchor = { ...annotation.anchor, x, y };
  annotation.updatedAt = Date.now();
  await setLocal({ annotations });
  return { ok: true };
}

export async function deleteAnnotation(id: string): Promise<AnnotationResult> {
  const { annotations } = await getLocal('annotations');
  await setLocal({ annotations: annotations.filter((a) => a.id !== id) });
  return { ok: true };
}
