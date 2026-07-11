import Foundation

/// Local-date helpers mirroring the extension's `src/shared/format.ts` and the
/// date math shared by week/streak/activity logic. Dates are local 'YYYY-MM-DD'.
public enum DateUtil {
    /// Local calendar date as 'YYYY-MM-DD'.
    public static func localDate(_ date: Date = Date()) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }

    /// `date` minus `n` calendar days.
    public static func daysAgo(_ n: Int, from date: Date = Date()) -> Date {
        Calendar.current.date(byAdding: .day, value: -n, to: date)!
    }

    /// Parse a local 'YYYY-MM-DD' at local noon (avoids DST off-by-ones when
    /// diffing calendar days). Nil for malformed input.
    public static func parseLocalDate(_ s: String) -> Date? {
        let parts = s.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return Calendar.current.date(
            from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }
}
