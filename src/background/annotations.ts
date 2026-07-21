import { ANNOTATION_TEXT_MAX_CHARS, MAX_PDF_ANNOTATIONS } from '../shared/constants';
import { getLocal, setLocal } from '../shared/storage';
import type { PdfAnnotation, PdfAnnotationDraft } from '../shared/types';

/**
 * All PDF-annotation writes happen here in the service worker so the reader
 * page and any future surfaces never race each other.
 */

export type AnnotationResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

export async function addAnnotation(
  draft: PdfAnnotationDraft,
): Promise<AnnotationResult<{ annotation: PdfAnnotation }>> {
  if (!draft.docKey) return { ok: false, error: 'Annotation has no document key.' };
  if (draft.page < 1) return { ok: false, error: 'Invalid page number.' };
  if (draft.kind === 'highlight' && draft.rects.length === 0) {
    return { ok: false, error: 'Highlight has no selection rects.' };
  }
  const { pdfAnnotations } = await getLocal('pdfAnnotations');
  if (pdfAnnotations.length >= MAX_PDF_ANNOTATIONS) {
    return { ok: false, error: `Annotation limit reached (${MAX_PDF_ANNOTATIONS}).` };
  }
  const now = Date.now();
  const annotation: PdfAnnotation = {
    ...draft,
    text: draft.text.slice(0, ANNOTATION_TEXT_MAX_CHARS),
    note: draft.note.slice(0, ANNOTATION_TEXT_MAX_CHARS),
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  await setLocal({ pdfAnnotations: [...pdfAnnotations, annotation] });
  return { ok: true, annotation };
}

export async function updateAnnotation(
  id: string,
  patch: Partial<Pick<PdfAnnotation, 'note' | 'color' | 'x' | 'y'>>,
): Promise<AnnotationResult> {
  const { pdfAnnotations } = await getLocal('pdfAnnotations');
  const annotation = pdfAnnotations.find((a) => a.id === id);
  if (!annotation) return { ok: false, error: 'Annotation not found.' };
  Object.assign(annotation, patch);
  if (annotation.note.length > ANNOTATION_TEXT_MAX_CHARS) {
    annotation.note = annotation.note.slice(0, ANNOTATION_TEXT_MAX_CHARS);
  }
  annotation.updatedAt = Date.now();
  await setLocal({ pdfAnnotations });
  return { ok: true };
}

export async function deleteAnnotation(id: string): Promise<AnnotationResult> {
  const { pdfAnnotations } = await getLocal('pdfAnnotations');
  await setLocal({ pdfAnnotations: pdfAnnotations.filter((a) => a.id !== id) });
  return { ok: true };
}
