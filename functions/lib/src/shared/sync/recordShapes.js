"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.newTask = newTask;
exports.newFlashNoteWithCards = newFlashNoteWithCards;
exports.newPaper = newPaper;
const srs_1 = require("../srs");
/**
 * Record factories shared by every writer of synced collections: the
 * extension's background modules AND the WhatsApp bridge (functions/ includes
 * this file). One source of truth for record shapes and SRS defaults — a
 * record created remotely must be byte-compatible with one created locally,
 * or the merge layer's expectations drift. Pure: callers pass now/ids.
 */
function newTask(text, now, id, source = 'capture') {
    return {
        id,
        text: text.trim(),
        createdAt: now,
        completedAt: null,
        snoozedUntil: null,
        source,
        updatedAt: now,
    };
}
/**
 * A note is invisible without its cards: the extension derives FlashCard rows
 * only at write time (nothing regenerates cards from synced notes), so every
 * writer must persist the note AND its derived cards together.
 */
function newFlashNoteWithCards(args) {
    const type = args.type ?? 'basic';
    const note = {
        id: args.id,
        deckId: args.deckId,
        type,
        front: args.front.trim(),
        back: args.back.trim(),
        reversed: type === 'basic' && (args.reversed ?? false),
        createdAt: args.now,
        updatedAt: args.now,
    };
    return { note, cards: (0, srs_1.reconcileCards)(note, [], args.now) };
}
function newPaper(draft, now, id) {
    return {
        ...draft,
        id,
        addedAt: now,
        updatedAt: now,
        lastReadAt: draft.status === 'reading' ? now : null,
    };
}
//# sourceMappingURL=recordShapes.js.map