import Foundation

/// Streak insurance: freeze tokens auto-bridge missed days so one bad day
/// doesn't zero a long streak. Ported from `src/shared/streakInsurance.ts`.
/// Mutating helpers take `inout Streaks`; callers persist the result.
public enum StreakInsurance {
    public static let freezeTokenCap = 3
    /// A token is banked every N-th consecutive qualified day.
    public static let freezeEarnEvery = 5

    /// Whole calendar days strictly between two local 'YYYY-MM-DD' dates.
    public static func missedDays(_ lastQualifiedDate: String, _ today: String) -> Int {
        guard let from = DateUtil.parseLocalDate(lastQualifiedDate),
              let to = DateUtil.parseLocalDate(today) else { return 0 }
        let diff = Int(((to.timeIntervalSince1970 - from.timeIntervalSince1970) / 86_400).rounded())
        return max(0, diff - 1)
    }

    public struct BridgeResult: Equatable, Sendable {
        public let bridged: Bool
        public let tokensSpent: Int
    }

    /// If the gap since the last qualified day is coverable by available tokens
    /// (one per missed day), spend them and pull lastQualifiedDate to yesterday.
    @discardableResult
    public static func bridgeGap(_ streaks: inout Streaks, today: String = DateUtil.localDate()) -> BridgeResult {
        let missed = missedDays(streaks.lastQualifiedDate, today)
        let tokens = streaks.freezeTokens ?? 0
        if streaks.currentStreak <= 0 || missed == 0 || missed > tokens {
            return BridgeResult(bridged: false, tokensSpent: 0)
        }
        let todayDate = DateUtil.parseLocalDate(today) ?? Date()
        streaks.freezeTokens = tokens - missed
        streaks.lastQualifiedDate = DateUtil.localDate(DateUtil.daysAgo(1, from: todayDate))
        return BridgeResult(bridged: true, tokensSpent: missed)
    }

    /// Bank a token on every FREEZE_EARN_EVERY-th consecutive day, up to the cap.
    @discardableResult
    public static func maybeEarnToken(_ streaks: inout Streaks) -> Bool {
        if streaks.currentStreak <= 0 || streaks.currentStreak % freezeEarnEvery != 0 { return false }
        let tokens = streaks.freezeTokens ?? 0
        if tokens >= freezeTokenCap { return false }
        streaks.freezeTokens = tokens + 1
        return true
    }
}
