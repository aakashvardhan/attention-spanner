"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LEARN_AHEAD_MIN = exports.MAX_INTERVAL_DAYS = exports.NEW_PER_DAY = exports.MIN_EASE = exports.START_EASE = exports.EASY_INTERVAL_DAYS = exports.GRADUATING_INTERVAL_DAYS = exports.RELEARNING_STEPS_MIN = exports.LEARNING_STEPS_MIN = void 0;
exports.newCard = newCard;
exports.answerCard = answerCard;
exports.formatInterval = formatInterval;
exports.previewIntervals = previewIntervals;
exports.cardsForNote = cardsForNote;
exports.reconcileCards = reconcileCards;
exports.endOfLocalDay = endOfLocalDay;
exports.buildQueue = buildQueue;
exports.dueCounts = dueCounts;
exports.totalDue = totalDue;
exports.newIntroducedToday = newIntroducedToday;
exports.isRewardableAnswer = isRewardableAnswer;
const cloze_1 = require("./cloze");
/**
 * Anki-classic SM-2 scheduler. Pure functions only: every entry point takes
 * `now` (ms epoch) so tests inject time. No fuzz in v1 — if added later it
 * belongs at the end of answerCard, jittering review intervals by ±5%.
 */
exports.LEARNING_STEPS_MIN = [1, 10];
exports.RELEARNING_STEPS_MIN = [10];
exports.GRADUATING_INTERVAL_DAYS = 1;
exports.EASY_INTERVAL_DAYS = 4;
exports.START_EASE = 2.5;
exports.MIN_EASE = 1.3;
exports.NEW_PER_DAY = 20;
exports.MAX_INTERVAL_DAYS = 36500;
exports.LEARN_AHEAD_MIN = 20;
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
function newCard(noteId, deckId, variant, now) {
    return {
        id: `${noteId}#${variant}`,
        noteId,
        deckId,
        variant,
        phase: 'new',
        stepIndex: 0,
        ease: exports.START_EASE,
        intervalDays: 0,
        dueAt: now,
        lapses: 0,
        reps: 0,
        createdAt: now,
    };
}
function clampEase(ease) {
    return Math.max(exports.MIN_EASE, Math.round(ease * 100) / 100);
}
function clampInterval(days) {
    return Math.min(exports.MAX_INTERVAL_DAYS, days);
}
function graduate(card, intervalDays, now) {
    return {
        ...card,
        phase: 'review',
        stepIndex: 0,
        intervalDays,
        dueAt: now + intervalDays * DAY_MS,
    };
}
function answerCard(card, rating, now) {
    const next = (() => {
        if (card.phase === 'new' || card.phase === 'learning') {
            const steps = exports.LEARNING_STEPS_MIN;
            switch (rating) {
                case 'again':
                    return { ...card, phase: 'learning', stepIndex: 0, dueAt: now + steps[0] * MIN_MS };
                case 'hard': {
                    // Repeat the current step
                    const step = steps[Math.min(card.stepIndex, steps.length - 1)];
                    return { ...card, phase: 'learning', dueAt: now + step * MIN_MS };
                }
                case 'good': {
                    const nextStep = card.phase === 'new' ? 1 : card.stepIndex + 1;
                    if (nextStep >= steps.length)
                        return graduate(card, exports.GRADUATING_INTERVAL_DAYS, now);
                    return { ...card, phase: 'learning', stepIndex: nextStep, dueAt: now + steps[nextStep] * MIN_MS };
                }
                case 'easy':
                    return graduate(card, exports.EASY_INTERVAL_DAYS, now);
            }
        }
        if (card.phase === 'review') {
            const i = card.intervalDays;
            switch (rating) {
                case 'again':
                    // Lapse: ease penalty, relearn steps; post-relearn interval is 1 day
                    return {
                        ...card,
                        phase: 'relearning',
                        stepIndex: 0,
                        ease: clampEase(card.ease - 0.2),
                        lapses: card.lapses + 1,
                        intervalDays: 1,
                        dueAt: now + exports.RELEARNING_STEPS_MIN[0] * MIN_MS,
                    };
                case 'hard': {
                    const interval = clampInterval(Math.max(i + 1, Math.round(i * 1.2)));
                    return {
                        ...card,
                        ease: clampEase(card.ease - 0.15),
                        intervalDays: interval,
                        dueAt: now + interval * DAY_MS,
                    };
                }
                case 'good': {
                    const interval = clampInterval(Math.max(i + 1, Math.round(i * card.ease)));
                    return { ...card, intervalDays: interval, dueAt: now + interval * DAY_MS };
                }
                case 'easy': {
                    const interval = clampInterval(Math.max(i + 1, Math.round(i * card.ease * 1.3)));
                    return {
                        ...card,
                        ease: clampEase(card.ease + 0.15),
                        intervalDays: interval,
                        dueAt: now + interval * DAY_MS,
                    };
                }
            }
        }
        // relearning
        const steps = exports.RELEARNING_STEPS_MIN;
        switch (rating) {
            case 'again':
                // No further ease penalty on relearn misses (Anki behavior)
                return { ...card, stepIndex: 0, dueAt: now + steps[0] * MIN_MS };
            case 'hard': {
                const step = steps[Math.min(card.stepIndex, steps.length - 1)];
                return { ...card, dueAt: now + step * MIN_MS };
            }
            case 'good': {
                const nextStep = card.stepIndex + 1;
                if (nextStep >= steps.length)
                    return graduate(card, card.intervalDays, now);
                return { ...card, stepIndex: nextStep, dueAt: now + steps[nextStep] * MIN_MS };
            }
            case 'easy':
                return graduate(card, card.intervalDays, now);
        }
    })();
    return { ...next, reps: card.reps + 1 };
}
/** Human label for a duration, matching Anki's answer-button previews */
function formatInterval(ms) {
    const mins = Math.round(ms / MIN_MS);
    if (mins < 60)
        return `${Math.max(1, mins)}m`;
    const days = ms / DAY_MS;
    if (days < 1)
        return `${Math.round(days * 24)}h`;
    if (days < 30)
        return `${Math.round(days)}d`;
    if (days < 365)
        return `${(days / 30.44).toFixed(1).replace(/\.0$/, '')}mo`;
    return `${(days / 365.25).toFixed(1).replace(/\.0$/, '')}yr`;
}
function previewIntervals(card, now) {
    const out = {};
    for (const rating of ['again', 'hard', 'good', 'easy']) {
        out[rating] = formatInterval(answerCard(card, rating, now).dueAt - now);
    }
    return out;
}
/** Variant numbers a note should have cards for */
function cardsForNote(note) {
    if (note.type === 'cloze')
        return (0, cloze_1.clozeIndexes)(note.front);
    return note.reversed ? [0, 1] : [0];
}
/**
 * Reconcile a note's cards after create/edit: surviving variants keep their
 * scheduling state, new variants start fresh, removed variants are dropped.
 */
function reconcileCards(note, existing, now) {
    const byVariant = new Map(existing.map((c) => [c.variant, c]));
    return cardsForNote(note).map((variant) => byVariant.get(variant) ?? newCard(note.id, note.deckId, variant, now));
}
/** Local end of day (exclusive): review cards are "due today" until local midnight */
function endOfLocalDay(now) {
    const d = new Date(now);
    d.setHours(24, 0, 0, 0);
    return d.getTime();
}
/**
 * Ordered study queue for one deck:
 * 1. learning/relearning cards already due,
 * 2. new cards (oldest first) within the remaining daily allowance,
 * 3. review cards due today,
 * 4. if all else is empty, learning cards due within LEARN_AHEAD_MIN.
 */
function buildQueue(cards, deckId, now, newIntroducedToday) {
    const deck = cards.filter((c) => c.deckId === deckId);
    const byDue = (a, b) => a.dueAt - b.dueAt;
    const learning = deck
        .filter((c) => (c.phase === 'learning' || c.phase === 'relearning') && c.dueAt <= now)
        .sort(byDue);
    const fresh = deck
        .filter((c) => c.phase === 'new')
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, Math.max(0, exports.NEW_PER_DAY - newIntroducedToday));
    const review = deck
        .filter((c) => c.phase === 'review' && c.dueAt <= endOfLocalDay(now))
        .sort(byDue);
    const queue = [...learning, ...fresh, ...review];
    if (queue.length > 0)
        return queue;
    return deck
        .filter((c) => (c.phase === 'learning' || c.phase === 'relearning') &&
        c.dueAt <= now + exports.LEARN_AHEAD_MIN * MIN_MS)
        .sort(byDue);
}
/** Due counts per deck — shared by deck list, dashboard card, and popup tab */
function dueCounts(cards, now, newIntroducedByDeck) {
    const endOfDay = endOfLocalDay(now);
    const out = {};
    for (const card of cards) {
        const counts = (out[card.deckId] ??= { newCount: 0, learningCount: 0, reviewCount: 0 });
        if (card.phase === 'new')
            counts.newCount += 1;
        else if ((card.phase === 'learning' || card.phase === 'relearning') && card.dueAt <= now)
            counts.learningCount += 1;
        else if (card.phase === 'review' && card.dueAt <= endOfDay)
            counts.reviewCount += 1;
    }
    for (const [deckId, counts] of Object.entries(out)) {
        const allowance = Math.max(0, exports.NEW_PER_DAY - (newIntroducedByDeck[deckId] ?? 0));
        counts.newCount = Math.min(counts.newCount, allowance);
    }
    return out;
}
/** Total cards due across all decks (dashboard headline / popup badge) */
function totalDue(counts) {
    return Object.values(counts).reduce((sum, c) => sum + c.newCount + c.learningCount + c.reviewCount, 0);
}
/** newIntroduced-by-deck for today, from the srsDaily aggregate */
function newIntroducedToday(srsDaily, todayKey) {
    return srsDaily[todayKey]?.newIntroduced ?? {};
}
/** True when answering this card should award XP (see gamification design) */
function isRewardableAnswer(prevPhase, next) {
    if (prevPhase === 'review')
        return true;
    return (prevPhase === 'new' || prevPhase === 'learning') && next.phase === 'review';
}
//# sourceMappingURL=srs.js.map