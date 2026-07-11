import Foundation

/// Note → card reconciliation (SM-2), ported from the tail of `src/shared/srs.ts`.
extension SRS {
    /// Variant numbers a note should have cards for.
    public static func cardsForNote(_ note: FlashNote) -> [Int] {
        if note.type == .cloze { return Cloze.clozeIndexes(note.front) }
        return note.reversed ? [0, 1] : [0]
    }

    /// Reconcile a note's cards after create/edit: surviving variants keep their
    /// scheduling state, new variants start fresh, removed variants are dropped.
    public static func reconcileCards(_ note: FlashNote, existing: [FlashCard], now: Millis) -> [FlashCard] {
        let byVariant = Dictionary(existing.map { ($0.variant, $0) }, uniquingKeysWith: { first, _ in first })
        return cardsForNote(note).map { variant in
            byVariant[variant] ?? newCard(noteId: note.id, deckId: note.deckId, variant: variant, now: now)
        }
    }

    /// newIntroduced-by-deck for today, from the srsDaily aggregate.
    public static func newIntroducedToday(_ srsDaily: [String: SrsDayStats], todayKey: String) -> [String: Int] {
        srsDaily[todayKey]?.newIntroduced ?? [:]
    }
}
