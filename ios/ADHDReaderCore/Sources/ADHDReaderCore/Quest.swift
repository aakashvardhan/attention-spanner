import Foundation

/// Weekly quest, derived from gym check-ins + streaks.daily. Ported from
/// `src/shared/quest.ts`.
public struct QuestSettings: Sendable {
    public let gymWeeklyTarget: Int
    public let questArticlesPerWeek: Int
    public let questSprintsPerWeek: Int
    public let questVideosPerWeek: Int
    public let questFocusPerWeek: Int

    public init(
        gymWeeklyTarget: Int, questArticlesPerWeek: Int, questSprintsPerWeek: Int,
        questVideosPerWeek: Int, questFocusPerWeek: Int
    ) {
        self.gymWeeklyTarget = gymWeeklyTarget; self.questArticlesPerWeek = questArticlesPerWeek
        self.questSprintsPerWeek = questSprintsPerWeek; self.questVideosPerWeek = questVideosPerWeek
        self.questFocusPerWeek = questFocusPerWeek
    }
}

public struct QuestLine: Equatable, Sendable {
    public let key: String
    public let emoji: String
    public let label: String
    public let current: Int
    public let target: Int
}

public struct QuestProgress: Equatable, Sendable {
    public let lines: [QuestLine]
    public let complete: Bool
}

public enum Quest {
    public static func progress(
        checkins: [String: Int], daily: [String: DayStats], settings: QuestSettings,
        week: String = Week.weekKey()
    ) -> QuestProgress {
        let dates = Week.weekDates(week)
        func sum(_ pick: (DayStats) -> Int) -> Int {
            dates.reduce(0) { $0 + (daily[$1].map(pick) ?? 0) }
        }
        let all: [QuestLine] = [
            QuestLine(key: "gym", emoji: "💪", label: "Gym",
                      current: Week.countInWeek(checkins, week), target: settings.gymWeeklyTarget),
            QuestLine(key: "articles", emoji: "📖", label: "Articles",
                      current: sum { $0.articlesFinished }, target: settings.questArticlesPerWeek),
            QuestLine(key: "sprints", emoji: "⏱️", label: "Sprints",
                      current: sum { $0.sprints }, target: settings.questSprintsPerWeek),
            QuestLine(key: "videos", emoji: "🎬", label: "Videos",
                      current: sum { $0.videosFinished ?? 0 }, target: settings.questVideosPerWeek),
            QuestLine(key: "focus", emoji: "🎯", label: "Focus blocks",
                      current: sum { $0.focusBlocks ?? 0 }, target: settings.questFocusPerWeek),
        ]
        let lines = all.filter { $0.target > 0 }
        return QuestProgress(
            lines: lines,
            complete: !lines.isEmpty && lines.allSatisfy { $0.current >= $0.target })
    }
}
