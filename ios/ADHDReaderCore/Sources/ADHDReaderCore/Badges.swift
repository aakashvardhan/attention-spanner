import Foundation

/// Badge catalog — pure data + predicates over a stats snapshot. Ported from
/// `src/shared/badges.ts`. Badges unlock once and are never revoked.
public struct StatsSnapshot: Sendable {
    public var workouts: Int
    public var gymWeekStreak: Int
    public var articlesFinished: Int
    public var videosFinished: Int
    public var readingStreak: Int
    public var sprints: Int
    public var tasksCompleted: Int
    public var brainDumps: Int
    public var focusBlocks: Int
    public var cardsReviewed: Int
    public var chestsOpened: Int
    public var level: Int

    public init(
        workouts: Int = 0, gymWeekStreak: Int = 0, articlesFinished: Int = 0, videosFinished: Int = 0,
        readingStreak: Int = 0, sprints: Int = 0, tasksCompleted: Int = 0, brainDumps: Int = 0,
        focusBlocks: Int = 0, cardsReviewed: Int = 0, chestsOpened: Int = 0, level: Int = 1
    ) {
        self.workouts = workouts; self.gymWeekStreak = gymWeekStreak
        self.articlesFinished = articlesFinished; self.videosFinished = videosFinished
        self.readingStreak = readingStreak; self.sprints = sprints
        self.tasksCompleted = tasksCompleted; self.brainDumps = brainDumps
        self.focusBlocks = focusBlocks; self.cardsReviewed = cardsReviewed
        self.chestsOpened = chestsOpened; self.level = level
    }
}

public struct Badge: Sendable {
    public let id: String
    public let emoji: String
    public let title: String
    public let description: String
    public let earned: @Sendable (StatsSnapshot) -> Bool
}

public enum Badges {
    public static let all: [Badge] = [
        Badge(id: "first-workout", emoji: "💪", title: "First Rep", description: "Log your first workout", earned: { $0.workouts >= 1 }),
        Badge(id: "gym-10", emoji: "🏋️", title: "Regular", description: "Log 10 workouts", earned: { $0.workouts >= 10 }),
        Badge(id: "gym-50", emoji: "🦾", title: "Iron Habit", description: "Log 50 workouts", earned: { $0.workouts >= 50 }),
        Badge(id: "gym-streak-4", emoji: "📆", title: "Four-Week Club", description: "Hit your gym goal 4 weeks in a row", earned: { $0.gymWeekStreak >= 4 }),
        Badge(id: "gym-streak-12", emoji: "🗓️", title: "Quarter Machine", description: "Hit your gym goal 12 weeks in a row", earned: { $0.gymWeekStreak >= 12 }),
        Badge(id: "first-article", emoji: "📖", title: "Finisher", description: "Finish reading your first article", earned: { $0.articlesFinished >= 1 }),
        Badge(id: "articles-10", emoji: "📚", title: "Ten Down", description: "Finish 10 articles", earned: { $0.articlesFinished >= 10 }),
        Badge(id: "articles-50", emoji: "🏛️", title: "Well Read", description: "Finish 50 articles", earned: { $0.articlesFinished >= 50 }),
        Badge(id: "first-video", emoji: "🎬", title: "Press Play", description: "Finish your first long video", earned: { $0.videosFinished >= 1 }),
        Badge(id: "videos-10", emoji: "📺", title: "Binge Learner", description: "Finish 10 long videos", earned: { $0.videosFinished >= 10 }),
        Badge(id: "videos-50", emoji: "🎓", title: "Lecture Hall", description: "Finish 50 long videos", earned: { $0.videosFinished >= 50 }),
        Badge(id: "read-streak-7", emoji: "🔥", title: "Week of Focus", description: "A 7-day reading streak", earned: { $0.readingStreak >= 7 }),
        Badge(id: "read-streak-30", emoji: "🌋", title: "Thirty-Day Flame", description: "A 30-day reading streak", earned: { $0.readingStreak >= 30 }),
        Badge(id: "sprints-25", emoji: "⏱️", title: "Sprinter", description: "Complete 25 reading sprints", earned: { $0.sprints >= 25 }),
        Badge(id: "sprints-100", emoji: "🚀", title: "Century Sprints", description: "Complete 100 reading sprints", earned: { $0.sprints >= 100 }),
        Badge(id: "first-focus", emoji: "🎯", title: "Locked In", description: "Complete your first focus block", earned: { $0.focusBlocks >= 1 }),
        Badge(id: "focus-25", emoji: "🛡️", title: "Distraction Slayer", description: "Complete 25 focus blocks", earned: { $0.focusBlocks >= 25 }),
        Badge(id: "focus-100", emoji: "🏰", title: "Deep Work", description: "Complete 100 focus blocks", earned: { $0.focusBlocks >= 100 }),
        Badge(id: "tasks-50", emoji: "✅", title: "Task Slayer", description: "Complete 50 tasks", earned: { $0.tasksCompleted >= 50 }),
        Badge(id: "cards-100", emoji: "🃏", title: "Century Recall", description: "Review 100 flashcards", earned: { $0.cardsReviewed >= 100 }),
        Badge(id: "dumps-10", emoji: "🧠", title: "Mind Gardener", description: "Structure 10 brain dumps", earned: { $0.brainDumps >= 10 }),
        Badge(id: "chests-10", emoji: "🎁", title: "Lucky Day", description: "Open 10 mystery chests", earned: { $0.chestsOpened >= 10 }),
        Badge(id: "level-5", emoji: "⭐", title: "Level 5", description: "Reach level 5", earned: { $0.level >= 5 }),
        Badge(id: "level-10", emoji: "🌟", title: "Level 10", description: "Reach level 10", earned: { $0.level >= 10 }),
    ]
}
