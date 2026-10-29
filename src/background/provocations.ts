import { ANNOTATION_TEXT_MAX_CHARS, MAX_PROVOCATIONS } from '../shared/constants';
import { getLocal, setLocal } from '../shared/storage';
import { xpAward } from '../shared/thinking';
import type { Provocation, ProvocationDraft } from '../shared/types';

/** Provocation writes live in the service worker, like annotations. XP is awarded once per record. */

const cap = (s: string) => s.slice(0, ANNOTATION_TEXT_MAX_CHARS);

export async function addProvocation(
  draft: ProvocationDraft,
): Promise<{ ok: true; provocation: Provocation } | { ok: false; error: string }> {
  if (!draft.docKey) return { ok: false, error: 'Provocation has no document key.' };
  const { provocations } = await getLocal('provocations');
  if (provocations.length >= MAX_PROVOCATIONS) {
    return { ok: false, error: `Provocation limit reached (${MAX_PROVOCATIONS}).` };
  }
  const now = Date.now();
  const provocation: Provocation = {
    ...draft,
    question: cap(draft.question),
    answer: cap(draft.answer),
    id: crypto.randomUUID(),
    xp: 0,
    createdAt: now,
    updatedAt: now,
  };
  provocation.xp = xpAward(null, provocation);
  await setLocal({ provocations: [...provocations, provocation] });
  return { ok: true, provocation };
}

export async function updateProvocation(
  id: string,
  patch: Partial<Pick<Provocation, 'answer' | 'status' | 'response' | 'citedPage'>>,
): Promise<{ ok: true; xp: number } | { ok: false; error: string }> {
  const { provocations } = await getLocal('provocations');
  const i = provocations.findIndex((p) => p.id === id);
  if (i < 0) return { ok: false, error: 'Provocation not found.' };
  const prev = provocations[i];
  const next: Provocation = { ...prev, ...patch, updatedAt: Date.now() };
  next.answer = cap(next.answer);
  next.xp = prev.xp + xpAward(prev, next);
  provocations[i] = next;
  await setLocal({ provocations });
  return { ok: true, xp: next.xp };
}
