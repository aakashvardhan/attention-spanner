import Foundation

/// Anki-classic SM-2 scheduler, ported 1:1 from `src/shared/srs.ts`. Pure:
/// every entry point takes `now` (ms epoch) so tests inject time. SRSTests
/// mirrors the Vitest suite.
public enum SRS {
    public static let learningStepsMin = [1, 10]
    public static let relearningStepsMin = [10]
    public static let graduatingIntervalDays = 1
    public static let easyIntervalDays = 4
    public static let startEase = 2.5
    public static let minEase = 1.3
    public static let newPerDay = 20
    public static let maxIntervalDays = 36_500
    public static let learnAheadMin = 20

    static let minMs = 60_000
    static let dayMs = 86_400_000

    public static func newCard(noteId: String, deckId: String, variant: Int, now: Millis) -> FlashCard {
        FlashCard(
            id: "\(noteId)#\(variant)", noteId: noteId, deckId: deckId, variant: variant,
            phase: .new, stepIndex: 0, ease: startEase, intervalDays: 0, dueAt: now,
            lapses: 0, reps: 0, createdAt: now
        )
    }

    private static func clampEase(_ ease: Double) -> Double {
        max(minEase, (ease * 100).rounded() / 100)
    }

    private static func clampInterval(_ days: Int) -> Int { min(maxIntervalDays, days) }

    private static func graduate(_ card: FlashCard, _ intervalDays: Int, _ now: Millis) -> FlashCard {
        var c = card
        c.phase = .review
        c.stepIndex = 0
        c.intervalDays = intervalDays
        c.dueAt = now + intervalDays * dayMs
        return c
    }

    public static func answerCard(_ card: FlashCard, _ rating: Rating, now: Millis) -> FlashCard {
        var next = computeNext(card, rating, now)
        next.reps = card.reps + 1
        return next
    }

    private static func computeNext(_ card: FlashCard, _ rating: Rating, _ now: Millis) -> FlashCard {
        var c = card
        if card.phase == .new || card.phase == .learning {
            let steps = learningStepsMin
            switch rating {
            case .again:
                c.phase = .learning; c.stepIndex = 0; c.dueAt = now + steps[0] * minMs
                return c
            case .hard:
                let step = steps[min(card.stepIndex, steps.count - 1)]
                c.phase = .learning; c.dueAt = now + step * minMs
                return c
            case .good:
                let nextStep = card.phase == .new ? 1 : card.stepIndex + 1
                if nextStep >= steps.count { return graduate(card, graduatingIntervalDays, now) }
                c.phase = .learning; c.stepIndex = nextStep; c.dueAt = now + steps[nextStep] * minMs
                return c
            case .easy:
                return graduate(card, easyIntervalDays, now)
            }
        }

        if card.phase == .review {
            let i = card.intervalDays
            switch rating {
            case .again:
                c.phase = .relearning; c.stepIndex = 0
                c.ease = clampEase(card.ease - 0.2); c.lapses = card.lapses + 1
                c.intervalDays = 1; c.dueAt = now + relearningStepsMin[0] * minMs
                return c
            case .hard:
                let interval = clampInterval(max(i + 1, Int((Double(i) * 1.2).rounded())))
                c.ease = clampEase(card.ease - 0.15)
                c.intervalDays = interval; c.dueAt = now + interval * dayMs
                return c
            case .good:
                let interval = clampInterval(max(i + 1, Int((Double(i) * card.ease).rounded())))
                c.intervalDays = interval; c.dueAt = now + interval * dayMs
                return c
            case .easy:
                let interval = clampInterval(max(i + 1, Int((Double(i) * card.ease * 1.3).rounded())))
                c.ease = clampEase(card.ease + 0.15)
                c.intervalDays = interval; c.dueAt = now + interval * dayMs
                return c
            }
        }

        // relearning
        let steps = relearningStepsMin
        switch rating {
        case .again:
            c.stepIndex = 0; c.dueAt = now + steps[0] * minMs
            return c
        case .hard:
            let step = steps[min(card.stepIndex, steps.count - 1)]
            c.dueAt = now + step * minMs
            return c
        case .good:
            let nextStep = card.stepIndex + 1
            if nextStep >= steps.count { return graduate(card, card.intervalDays, now) }
            c.stepIndex = nextStep; c.dueAt = now + steps[nextStep] * minMs
            return c
        case .easy:
            return graduate(card, card.intervalDays, now)
        }
    }

    /// Human label for a duration, matching Anki's answer-button previews.
    public static func formatInterval(_ ms: Int) -> String {
        let mins = Int((Double(ms) / Double(minMs)).rounded())
        if mins < 60 { return "\(max(1, mins))m" }
        let days = Double(ms) / Double(dayMs)
        if days < 1 { return "\(Int((days * 24).rounded()))h" }
        if days < 30 { return "\(Int(days.rounded()))d" }
        if days < 365 { return "\(trimmed(days / 30.44))mo" }
        return "\(trimmed(days / 365.25))yr"
    }

    /// One decimal place, trailing ".0" stripped (matches JS `.toFixed(1).replace`).
    private static func trimmed(_ value: Double) -> String {
        let s = String(format: "%.1f", value)
        return s.hasSuffix(".0") ? String(s.dropLast(2)) : s
    }

    public static func previewIntervals(_ card: FlashCard, now: Millis) -> [Rating: String] {
        var out: [Rating: String] = [:]
        for rating in Rating.allCases {
            out[rating] = formatInterval(answerCard(card, rating, now: now).dueAt - now)
        }
        return out
    }

    /// Local end of day (exclusive): review cards are "due today" until local midnight.
    public static func endOfLocalDay(_ now: Millis) -> Millis {
        let date = Date(timeIntervalSince1970: Double(now) / 1000)
        let cal = Calendar.current
        let start = cal.startOfDay(for: date)
        let next = cal.date(byAdding: .day, value: 1, to: start)!
        return Int((next.timeIntervalSince1970 * 1000).rounded())
    }

    /// Ordered study queue for one deck (learning → new within allowance →
    /// review due today → learn-ahead fallback).
    public static func buildQueue(
        _ cards: [FlashCard], deckId: String, now: Millis, newIntroducedToday: Int
    ) -> [FlashCard] {
        let deck = cards.filter { $0.deckId == deckId }
        let byDue: (FlashCard, FlashCard) -> Bool = { $0.dueAt < $1.dueAt }

        let learning = deck
            .filter { ($0.phase == .learning || $0.phase == .relearning) && $0.dueAt <= now }
            .sorted(by: byDue)
        let fresh = deck
            .filter { $0.phase == .new }
            .sorted { $0.createdAt < $1.createdAt }
            .prefix(max(0, newPerDay - newIntroducedToday))
        let endOfDay = endOfLocalDay(now)
        let review = deck
            .filter { $0.phase == .review && $0.dueAt <= endOfDay }
            .sorted(by: byDue)

        let queue = learning + Array(fresh) + review
        if !queue.isEmpty { return queue }

        return deck
            .filter {
                ($0.phase == .learning || $0.phase == .relearning)
                    && $0.dueAt <= now + learnAheadMin * minMs
            }
            .sorted(by: byDue)
    }

    public struct DeckDueCounts: Equatable, Sendable {
        public var newCount: Int
        public var learningCount: Int
        public var reviewCount: Int
        public init(newCount: Int = 0, learningCount: Int = 0, reviewCount: Int = 0) {
            self.newCount = newCount; self.learningCount = learningCount; self.reviewCount = reviewCount
        }
    }

    /// Due counts per deck — shared by deck list, dashboard card, and popup tab.
    public static func dueCounts(
        _ cards: [FlashCard], now: Millis, newIntroducedByDeck: [String: Int]
    ) -> [String: DeckDueCounts] {
        let endOfDay = endOfLocalDay(now)
        var out: [String: DeckDueCounts] = [:]
        for card in cards {
            var counts = out[card.deckId] ?? DeckDueCounts()
            if card.phase == .new {
                counts.newCount += 1
            } else if (card.phase == .learning || card.phase == .relearning) && card.dueAt <= now {
                counts.learningCount += 1
            } else if card.phase == .review && card.dueAt <= endOfDay {
                counts.reviewCount += 1
            }
            out[card.deckId] = counts
        }
        for (deckId, var counts) in out {
            let allowance = max(0, newPerDay - (newIntroducedByDeck[deckId] ?? 0))
            counts.newCount = min(counts.newCount, allowance)
            out[deckId] = counts
        }
        return out
    }

    /// Total cards due across all decks.
    public static func totalDue(_ counts: [String: DeckDueCounts]) -> Int {
        counts.values.reduce(0) { $0 + $1.newCount + $1.learningCount + $1.reviewCount }
    }

    /// True when answering this card should award XP (see gamification design).
    public static func isRewardableAnswer(prevPhase: CardPhase, next: FlashCard) -> Bool {
        if prevPhase == .review { return true }
        return (prevPhase == .new || prevPhase == .learning) && next.phase == .review
    }
}
