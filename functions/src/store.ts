import { randomUUID } from 'node:crypto';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import {
  newFlashNoteWithCards,
  newPaper,
  newTask,
} from '../../src/shared/sync/recordShapes';
import type { Deck, Paper, Task } from '../../src/shared/types';

/**
 * Firestore writes that honor the extension's merge contract
 * (src/background/sync.ts):
 *
 * - Records live at users/{uid}/{collection}/{id} with `updatedAt` stamped —
 *   the extension merges them by last-write-wins (mergeById).
 * - Deletes MUST also merge `${collection}:${id}` → now into the doc
 *   users/{uid}/meta/tombstones. Deleting the record doc alone is not enough:
 *   the extension still holds the record locally and would push it right back.
 * - Flashcards: a flashNote alone is invisible — the extension derives card
 *   rows only at write time, so the note and its cards are written together
 *   (both come from the shared recordShapes factories, the drift-proof seam).
 */

const db = (): Firestore => getFirestore();

const recordCol = (uid: string, collection: string) => db().collection(`users/${uid}/${collection}`);
const tombstonesDoc = (uid: string) => db().doc(`users/${uid}/meta/tombstones`);

async function writeTombstone(uid: string, collection: string, id: string): Promise<void> {
  await tombstonesDoc(uid).set({ [`${collection}:${id}`]: Date.now() }, { merge: true });
}

/* ---------- tasks ---------- */

/** Open tasks, newest first (matches the extension's unshift ordering) */
export async function listOpenTasks(uid: string): Promise<Task[]> {
  const snap = await recordCol(uid, 'tasks').get();
  return snap.docs
    .map((d) => d.data() as Task)
    .filter((t) => t.completedAt === null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function addTask(uid: string, text: string): Promise<Task> {
  const task = newTask(text, Date.now(), randomUUID(), 'capture');
  await recordCol(uid, 'tasks').doc(task.id).set(task);
  return task;
}

export async function completeTask(uid: string, task: Task): Promise<void> {
  const now = Date.now();
  await recordCol(uid, 'tasks').doc(task.id).set({ ...task, completedAt: now, updatedAt: now });
}

export async function editTask(uid: string, task: Task, text: string): Promise<void> {
  await recordCol(uid, 'tasks')
    .doc(task.id)
    .set({ ...task, text: text.trim(), updatedAt: Date.now() });
}

export async function deleteTask(uid: string, task: Task): Promise<void> {
  await recordCol(uid, 'tasks').doc(task.id).delete();
  await writeTombstone(uid, 'tasks', task.id);
}

/* ---------- decks / flashcards ---------- */

async function resolveDeck(uid: string, kind: Deck['kind'], name: string | null): Promise<Deck> {
  const snap = await recordCol(uid, 'decks').get();
  const decks = snap.docs
    .map((d) => d.data() as Deck)
    .filter((d) => (d.kind ?? 'flashcards') === kind);
  if (name) {
    const q = name.trim().toLowerCase();
    const hit = decks.find((d) => d.name.toLowerCase().includes(q));
    if (hit) return hit;
  }
  if (decks[0]) return decks[0];
  const now = Date.now();
  const deck = { id: randomUUID(), name: 'Inbox', createdAt: now, kind, updatedAt: now } as Deck;
  await recordCol(uid, 'decks').doc(deck.id).set(deck);
  return deck;
}

export async function addFlashcard(
  uid: string,
  deckName: string | null,
  front: string,
  back: string,
): Promise<{ deck: Deck }> {
  const deck = await resolveDeck(uid, 'flashcards', deckName);
  const { note, cards } = newFlashNoteWithCards({
    id: randomUUID(),
    deckId: deck.id,
    front,
    back,
    now: Date.now(),
  });
  const batch = db().batch();
  batch.set(recordCol(uid, 'flashNotes').doc(note.id), note);
  for (const card of cards) batch.set(recordCol(uid, 'flashCards').doc(card.id), card);
  await batch.commit();
  return { deck };
}

/* ---------- papers ---------- */

export async function listPapers(uid: string): Promise<Paper[]> {
  const snap = await recordCol(uid, 'papers').get();
  return snap.docs.map((d) => d.data() as Paper).sort((a, b) => b.addedAt - a.addedAt);
}

export async function addPaper(uid: string, ref: string): Promise<Paper> {
  const deck = await resolveDeck(uid, 'papers', null);
  const isUrl = /^https?:\/\//i.test(ref) || /^arxiv\.org|^doi\.org/i.test(ref);
  const url = isUrl ? (ref.startsWith('http') ? ref : `https://${ref}`) : '';
  const paper = newPaper(
    {
      deckId: deck.id,
      title: isUrl ? ref : ref.trim(),
      authors: '',
      venue: '',
      year: null,
      citations: null,
      url,
      abstract: '',
      relevance: '',
      status: 'to-read',
      progressPercent: 0,
      leftOff: '',
    },
    Date.now(),
    randomUUID(),
  );
  await recordCol(uid, 'papers').doc(paper.id).set(paper);
  return paper;
}

export async function deletePaper(uid: string, paper: Paper): Promise<void> {
  await recordCol(uid, 'papers').doc(paper.id).delete();
  await writeTombstone(uid, 'papers', paper.id);
}

/* ---------- fuzzy ref resolution (mirrors the extension's resolveByText spirit) ---------- */

export function resolveRef<T>(items: T[], textOf: (item: T) => string, ref: string): T | null {
  const q = ref.trim().toLowerCase();
  if (!q) return null;
  const exact = items.find((i) => textOf(i).toLowerCase() === q);
  if (exact) return exact;
  const contains = items.filter((i) => textOf(i).toLowerCase().includes(q));
  return contains.length === 1 ? contains[0] : null;
}
