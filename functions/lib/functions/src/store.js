"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listOpenTasks = listOpenTasks;
exports.addTask = addTask;
exports.completeTask = completeTask;
exports.editTask = editTask;
exports.deleteTask = deleteTask;
exports.addFlashcard = addFlashcard;
exports.listPapers = listPapers;
exports.addPaper = addPaper;
exports.deletePaper = deletePaper;
exports.resolveRef = resolveRef;
const node_crypto_1 = require("node:crypto");
const firestore_1 = require("firebase-admin/firestore");
const recordShapes_1 = require("../../src/shared/sync/recordShapes");
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
const db = () => (0, firestore_1.getFirestore)();
const recordCol = (uid, collection) => db().collection(`users/${uid}/${collection}`);
const tombstonesDoc = (uid) => db().doc(`users/${uid}/meta/tombstones`);
async function writeTombstone(uid, collection, id) {
    await tombstonesDoc(uid).set({ [`${collection}:${id}`]: Date.now() }, { merge: true });
}
/* ---------- tasks ---------- */
/** Open tasks, newest first (matches the extension's unshift ordering) */
async function listOpenTasks(uid) {
    const snap = await recordCol(uid, 'tasks').get();
    return snap.docs
        .map((d) => d.data())
        .filter((t) => t.completedAt === null)
        .sort((a, b) => b.createdAt - a.createdAt);
}
async function addTask(uid, text) {
    const task = (0, recordShapes_1.newTask)(text, Date.now(), (0, node_crypto_1.randomUUID)(), 'capture');
    await recordCol(uid, 'tasks').doc(task.id).set(task);
    return task;
}
async function completeTask(uid, task) {
    const now = Date.now();
    await recordCol(uid, 'tasks').doc(task.id).set({ ...task, completedAt: now, updatedAt: now });
}
async function editTask(uid, task, text) {
    await recordCol(uid, 'tasks')
        .doc(task.id)
        .set({ ...task, text: text.trim(), updatedAt: Date.now() });
}
async function deleteTask(uid, task) {
    await recordCol(uid, 'tasks').doc(task.id).delete();
    await writeTombstone(uid, 'tasks', task.id);
}
/* ---------- decks / flashcards ---------- */
async function resolveDeck(uid, kind, name) {
    const snap = await recordCol(uid, 'decks').get();
    const decks = snap.docs
        .map((d) => d.data())
        .filter((d) => (d.kind ?? 'flashcards') === kind);
    if (name) {
        const q = name.trim().toLowerCase();
        const hit = decks.find((d) => d.name.toLowerCase().includes(q));
        if (hit)
            return hit;
    }
    if (decks[0])
        return decks[0];
    const now = Date.now();
    const deck = { id: (0, node_crypto_1.randomUUID)(), name: 'Inbox', createdAt: now, kind, updatedAt: now };
    await recordCol(uid, 'decks').doc(deck.id).set(deck);
    return deck;
}
async function addFlashcard(uid, deckName, front, back) {
    const deck = await resolveDeck(uid, 'flashcards', deckName);
    const { note, cards } = (0, recordShapes_1.newFlashNoteWithCards)({
        id: (0, node_crypto_1.randomUUID)(),
        deckId: deck.id,
        front,
        back,
        now: Date.now(),
    });
    const batch = db().batch();
    batch.set(recordCol(uid, 'flashNotes').doc(note.id), note);
    for (const card of cards)
        batch.set(recordCol(uid, 'flashCards').doc(card.id), card);
    await batch.commit();
    return { deck };
}
/* ---------- papers ---------- */
async function listPapers(uid) {
    const snap = await recordCol(uid, 'papers').get();
    return snap.docs.map((d) => d.data()).sort((a, b) => b.addedAt - a.addedAt);
}
async function addPaper(uid, ref) {
    const deck = await resolveDeck(uid, 'papers', null);
    const isUrl = /^https?:\/\//i.test(ref) || /^arxiv\.org|^doi\.org/i.test(ref);
    const url = isUrl ? (ref.startsWith('http') ? ref : `https://${ref}`) : '';
    const paper = (0, recordShapes_1.newPaper)({
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
    }, Date.now(), (0, node_crypto_1.randomUUID)());
    await recordCol(uid, 'papers').doc(paper.id).set(paper);
    return paper;
}
async function deletePaper(uid, paper) {
    await recordCol(uid, 'papers').doc(paper.id).delete();
    await writeTombstone(uid, 'papers', paper.id);
}
/* ---------- fuzzy ref resolution (mirrors the extension's resolveByText spirit) ---------- */
function resolveRef(items, textOf, ref) {
    const q = ref.trim().toLowerCase();
    if (!q)
        return null;
    const exact = items.find((i) => textOf(i).toLowerCase() === q);
    if (exact)
        return exact;
    const contains = items.filter((i) => textOf(i).toLowerCase().includes(q));
    return contains.length === 1 ? contains[0] : null;
}
//# sourceMappingURL=store.js.map