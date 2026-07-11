import Foundation

/// XP economy + level curve, ported from `src/shared/levels.ts`.
/// Cumulative threshold xpForLevel(n) = 50·n·(n−1).
public enum Levels {
    public enum XpEvent: String, Sendable, CaseIterable {
        case gymCheckin = "gym_checkin"
        case articleFinished = "article_finished"
        case videoFinished = "video_finished"
        case sprintCompleted = "sprint_completed"
        case taskCompleted = "task_completed"
        case braindumpStructured = "braindump_structured"
        case focusBlock = "focus_block"
        case flashcardReview = "flashcard_review"
    }

    public static let xpValues: [XpEvent: Int] = [
        .focusBlock: 25, .gymCheckin: 20, .articleFinished: 15, .videoFinished: 15,
        .sprintCompleted: 10, .taskCompleted: 5, .braindumpStructured: 5, .flashcardReview: 5,
    ]

    public static let questXpBonus = 50

    /// Total XP required to reach `level` (level 1 = 0 XP).
    public static func xpForLevel(_ level: Int) -> Int { 50 * level * (level - 1) }

    public struct LevelInfo: Equatable, Sendable {
        public let level: Int
        public let intoLevel: Int
        public let toNext: Int
        public init(level: Int, intoLevel: Int, toNext: Int) {
            self.level = level; self.intoLevel = intoLevel; self.toNext = toNext
        }
    }

    public static func levelForXp(_ xp: Int) -> LevelInfo {
        var level = 1
        while xpForLevel(level + 1) <= xp { level += 1 }
        let floor = xpForLevel(level)
        return LevelInfo(level: level, intoLevel: xp - floor, toNext: xpForLevel(level + 1) - floor)
    }
}
