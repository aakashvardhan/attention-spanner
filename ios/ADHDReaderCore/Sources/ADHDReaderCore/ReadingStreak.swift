import Foundation

/// The reading streak, recomputed locally from synced `dayStats` (never synced
/// directly — it's derived). A day qualifies once active reading reaches the
/// daily goal OR at least one sprint finished, mirroring the extension's
/// `bumpToday` qualification rule. Freeze-token bridging is extension-only; a
/// missed day simply breaks the recomputed streak.
public enum ReadingStreak {
    public static func qualifies(_ day: DayStats, goalMinutes: Int) -> Bool {
        day.minutes >= Double(goalMinutes) || day.sprints >= 1
    }

    /// Consecutive qualifying days ending today (or yesterday, if today hasn't
    /// qualified yet — the streak is still alive until the day is missed).
    public static func current(_ daily: [String: DayStats], todayKey: String, goalMinutes: Int) -> Int {
        let cal = Calendar.current
        guard let today = DateUtil.parseLocalDate(todayKey) else { return 0 }
        func key(_ offset: Int) -> String {
            DateUtil.localDate(cal.date(byAdding: .day, value: -offset, to: today)!)
        }
        func qualifiesAt(_ offset: Int) -> Bool {
            guard let day = daily[key(offset)] else { return false }
            return qualifies(day, goalMinutes: goalMinutes)
        }

        let start: Int
        if qualifiesAt(0) { start = 0 }
        else if qualifiesAt(1) { start = 1 }
        else { return 0 }

        var streak = 0
        var offset = start
        while qualifiesAt(offset) {
            streak += 1
            offset += 1
        }
        return streak
    }
}
