"use strict";
/**
 * Cloze deletion parsing — Anki syntax: {{c1::answer}} or {{c1::answer::hint}}.
 * One card is generated per distinct cloze index; rendering blanks only the
 * active index and shows every other cloze's answer plainly (Anki behavior).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.clozeIndexes = clozeIndexes;
exports.renderCloze = renderCloze;
exports.clozeText = clozeText;
const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
/** Distinct cloze indexes in the text, sorted ascending. [] = not a valid cloze note. */
function clozeIndexes(text) {
    const indexes = new Set();
    for (const match of text.matchAll(CLOZE_RE)) {
        const index = Number(match[1]);
        if (index >= 1)
            indexes.add(index);
    }
    return [...indexes].sort((a, b) => a - b);
}
/**
 * Split cloze text into renderable segments for one card (activeIndex).
 * Front: active clozes become "[...]" (or "[hint]"); others show their answer.
 * Back: active clozes show their answer (marked active so the UI can accent it).
 */
function renderCloze(text, activeIndex, side) {
    const segments = [];
    let last = 0;
    for (const match of text.matchAll(CLOZE_RE)) {
        const index = Number(match[1]);
        const answer = match[2];
        const hint = match[3];
        const start = match.index;
        if (start > last)
            segments.push({ text: text.slice(last, start) });
        if (index < 1) {
            // Malformed index (c0): leave the raw text in place
            segments.push({ text: match[0] });
        }
        else if (index === activeIndex) {
            const blank = side === 'front' ? `[${hint ?? '...'}]` : answer;
            segments.push({ text: blank, cloze: { index, active: true } });
        }
        else {
            segments.push({ text: answer, cloze: { index, active: false } });
        }
        last = start + match[0].length;
    }
    if (last < text.length)
        segments.push({ text: text.slice(last) });
    return segments;
}
/** Convenience for plain-text previews (browse table, tests) */
function clozeText(text, activeIndex, side) {
    return renderCloze(text, activeIndex, side)
        .map((s) => s.text)
        .join('');
}
//# sourceMappingURL=cloze.js.map