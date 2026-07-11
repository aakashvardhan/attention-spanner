import Foundation

/// Activity scoring for the dashboard's contribution calendar, ported from
/// `src/shared/activity.ts`. The full `buildActivityDays` calendar builder is
/// deferred until the dashboard screen; these scoring primitives are what the
/// score/intensity mapping needs.
public enum Activity {
    public struct DayParts: Equatable, Sendable {
        public var minutes: Double
        public var sprints: Int
        public var articles: Int
        public var videos: Int
        public var focusBlocks: Int
        public var gym: Bool
        public var cardsReviewed: Int
        public var tasks: Int

        public init(
            minutes: Double = 0, sprints: Int = 0, articles: Int = 0, videos: Int = 0,
            focusBlocks: Int = 0, gym: Bool = false, cardsReviewed: Int = 0, tasks: Int = 0
        ) {
            self.minutes = minutes; self.sprints = sprints; self.articles = articles
            self.videos = videos; self.focusBlocks = focusBlocks; self.gym = gym
            self.cardsReviewed = cardsReviewed; self.tasks = tasks
        }
    }

    /// Each discrete completion = 1 point; continuous quantities normalized
    /// (15 min ≈ one activity, 10 reviews ≈ one activity).
    public static func dayActivityScore(_ p: DayParts) -> Int {
        p.tasks + p.articles + p.videos + p.sprints + p.focusBlocks
            + (p.gym ? 1 : 0)
            + Int(p.minutes / 15)
            + p.cardsReviewed / 10
    }

    public typealias Level = Int // 0…4

    /// GitHub-style quartiles of the year's max; any nonzero score is at least 1.
    public static func activityLevel(_ score: Int, max: Int) -> Level {
        if score <= 0 || max <= 0 { return 0 }
        let quartile = Int((Double(score) / Double(max) * 4).rounded(.up))
        return Swift.min(4, Swift.max(1, quartile))
    }

    // MARK: - Contribution calendar (buildActivityDays port)

    public struct ActivityDay: Equatable, Sendable, Identifiable {
        public let date: String          // local 'YYYY-MM-DD'
        public let score: Int
        public let level: Level          // 0…4
        public let tooltip: String
        public let future: Bool          // after today → invisible placeholder
        public var id: String { date }
    }

    public struct MonthLabel: Equatable, Sendable {
        public let columnIndex: Int
        public let label: String
    }

    public struct ActivityModel: Equatable, Sendable {
        /// Week columns (oldest first), each exactly 7 days Mon→Sun.
        public let weeks: [[ActivityDay]]
        public let monthLabels: [MonthLabel]
        public let totalActivities: Int
        public let maxScore: Int
    }

    private static func plural(_ n: Int, _ unit: String) -> String {
        "\(n) \(unit)\(n == 1 ? "" : "s")"
    }

    static let tooltipHeadFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateFormat = "EEE, MMM d"
        return f
    }()

    static let monthLabelFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateFormat = "MMM"
        return f
    }()

    public static func formatDayTooltip(_ date: Date, _ p: DayParts, score: Int) -> String {
        let head = tooltipHeadFormatter.string(from: date)
        if score == 0 { return "\(head) — No activity" }
        var bits: [String] = []
        if p.tasks > 0 { bits.append(plural(p.tasks, "task")) }
        if Int(p.minutes.rounded()) >= 1 { bits.append("\(Int(p.minutes.rounded())) min") }
        if p.sprints > 0 { bits.append(plural(p.sprints, "sprint")) }
        if p.articles > 0 { bits.append(plural(p.articles, "article")) }
        if p.videos > 0 { bits.append(plural(p.videos, "video")) }
        if p.focusBlocks > 0 { bits.append(plural(p.focusBlocks, "focus block")) }
        if p.gym { bits.append("gym") }
        if p.cardsReviewed > 0 { bits.append(plural(p.cardsReviewed, "review")) }
        return "\(head) — \(bits.joined(separator: " · "))"
    }

    static let minLabelGapColumns = 3

    /// GitHub-style contribution calendar model over the last `weeks` weeks,
    /// combining reading dayStats, gym check-ins, and card reviews. Ported 1:1
    /// from `buildActivityDays` in `src/shared/activity.ts`.
    public static func buildActivityDays(
        streaksDaily: [String: DayStats],
        gymCheckins: [String: Int],
        srsDaily: [String: SrsDayStats],
        todayKey: String,
        weeks: Int = 53
    ) -> ActivityModel {
        let cal = Calendar.current
        let today = DateUtil.parseLocalDate(todayKey) ?? Date()
        let jsDay = cal.component(.weekday, from: today) - 1   // Sun=0 … Sat=6
        let mondayOffset = (jsDay + 6) % 7                      // Mon=0 … Sun=6
        let startMonday = cal.date(
            byAdding: .day, value: -mondayOffset - (weeks - 1) * 7, to: today)!

        struct Cell { let day: ActivityDay; let parts: DayParts; let dateObj: Date }
        var columns: [[Cell]] = []
        var maxScore = 0
        var totalActivities = 0

        for w in 0..<weeks {
            var column: [Cell] = []
            for r in 0..<7 {
                let dateObj = cal.date(byAdding: .day, value: w * 7 + r, to: startMonday)!
                let date = DateUtil.localDate(dateObj)
                let stats = streaksDaily[date]
                let cardsReviewed = (srsDaily[date]?.reviews.values.reduce(0, +)) ?? 0
                let parts = DayParts(
                    minutes: stats?.minutes ?? 0,
                    sprints: stats?.sprints ?? 0,
                    articles: stats?.articlesFinished ?? 0,
                    videos: stats?.videosFinished ?? 0,
                    focusBlocks: stats?.focusBlocks ?? 0,
                    gym: gymCheckins[date] != nil,
                    cardsReviewed: cardsReviewed,
                    tasks: stats?.tasksCompleted ?? 0)
                let future = date > todayKey
                let score = future ? 0 : dayActivityScore(parts)
                maxScore = Swift.max(maxScore, score)
                totalActivities += score
                column.append(Cell(
                    day: ActivityDay(date: date, score: score, level: 0, tooltip: "", future: future),
                    parts: parts, dateObj: dateObj))
            }
            columns.append(column)
        }

        let weeksOut: [[ActivityDay]] = columns.map { column in
            column.map { cell in
                ActivityDay(
                    date: cell.day.date,
                    score: cell.day.score,
                    level: cell.day.future ? 0 : activityLevel(cell.day.score, max: maxScore),
                    tooltip: cell.day.future ? "" : formatDayTooltip(cell.dateObj, cell.parts, score: cell.day.score),
                    future: cell.day.future)
            }
        }

        var monthLabels: [MonthLabel] = []
        var prevMonth = -1
        // Sentinel chosen so the first new-month column always clears the gap
        // check (`w - lastLabelColumn >= gap`) without the Int.min underflow the
        // JS `-Infinity` avoided.
        var lastLabelColumn = -minLabelGapColumns
        for w in 0..<weeks {
            let monday = cal.date(byAdding: .day, value: w * 7, to: startMonday)!
            let month = cal.component(.month, from: monday)
            if month != prevMonth {
                if w - lastLabelColumn >= minLabelGapColumns {
                    monthLabels.append(MonthLabel(columnIndex: w, label: monthLabelFormatter.string(from: monday)))
                    lastLabelColumn = w
                }
                prevMonth = month
            }
        }

        return ActivityModel(
            weeks: weeksOut, monthLabels: monthLabels,
            totalActivities: totalActivities, maxScore: maxScore)
    }

    /// Consecutive days (ending today) with any activity — an objective streak
    /// that needs no daily-goal setting. Walks the model's days newest-first.
    public static func currentActivityStreak(_ model: ActivityModel, todayKey: String) -> Int {
        let days = model.weeks.flatMap { $0 }.filter { !$0.future }
        var streak = 0
        for day in days.reversed() {
            if day.score > 0 { streak += 1 } else { break }
        }
        return streak
    }
}
