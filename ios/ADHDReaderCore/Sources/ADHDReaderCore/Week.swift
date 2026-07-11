import Foundation

/// Week math for gym streaks, ported from `src/shared/week.ts`. Weeks are local
/// and start on Monday; a week is identified by its Monday's local 'YYYY-MM-DD'.
public enum Week {
    /// Monday of the week containing `date`.
    public static func weekKey(_ date: Date = Date()) -> String {
        let cal = Calendar.current
        let jsDay = cal.component(.weekday, from: date) - 1 // Sun=0 … Sat=6
        let offset = (jsDay + 6) % 7                        // Mon=0 … Sun=6
        let monday = cal.date(byAdding: .day, value: -offset, to: date)!
        return DateUtil.localDate(monday)
    }

    public static func prevWeekKey(_ key: String) -> String {
        let date = DateUtil.parseLocalDate(key)!
        return DateUtil.localDate(Calendar.current.date(byAdding: .day, value: -7, to: date)!)
    }

    /// The 7 local dates (Mon–Sun) of the week identified by `key`.
    public static func weekDates(_ key: String) -> [String] {
        let monday = DateUtil.parseLocalDate(key)!
        return (0..<7).map {
            DateUtil.localDate(Calendar.current.date(byAdding: .day, value: $0, to: monday)!)
        }
    }

    public static func countInWeek(_ checkins: [String: Int], _ key: String) -> Int {
        weekDates(key).filter { checkins[$0] != nil }.count
    }

    /// Next occurrence of a local 'HH:MM' wall-clock time, as ms epoch.
    public static func nextDailyOccurrence(_ hhmm: String, now: Date = Date()) -> Millis {
        let parts = hhmm.split(separator: ":").compactMap { Int($0) }
        let cal = Calendar.current
        var next = cal.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: now)!
        if next <= now { next = cal.date(byAdding: .day, value: 1, to: next)! }
        return Int((next.timeIntervalSince1970 * 1000).rounded())
    }
}
