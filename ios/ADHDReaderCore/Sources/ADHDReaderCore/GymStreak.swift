import Foundation

/// Gym weekly-goal streak, recomputed from synced check-ins (the stateful
/// `currentWeekStreak` isn't synced — it's derived). A week qualifies once it
/// hits the weekly target; the streak counts consecutive qualified weeks ending
/// this week (or last week, if this week hasn't hit the target yet).
public enum GymStreak {
    public static func weekQualifies(_ checkins: [String: Int], week: String, target: Int) -> Bool {
        target > 0 && Week.countInWeek(checkins, week) >= target
    }

    public static func current(_ checkins: [String: Int], thisWeek: String = Week.weekKey(), target: Int) -> Int {
        guard target > 0 else { return 0 }
        let start: String
        if weekQualifies(checkins, week: thisWeek, target: target) {
            start = thisWeek
        } else {
            let prev = Week.prevWeekKey(thisWeek)
            if weekQualifies(checkins, week: prev, target: target) { start = prev } else { return 0 }
        }
        var streak = 0
        var week = start
        while weekQualifies(checkins, week: week, target: target) {
            streak += 1
            week = Week.prevWeekKey(week)
        }
        return streak
    }
}
