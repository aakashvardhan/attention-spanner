import Foundation

/// Cloud-sync merge/tombstone contract, ported 1:1 from the extension's
/// `src/shared/sync/merge.ts` and `collections.ts`. The two surfaces MUST
/// produce identical outcomes; SyncMergeTests mirrors the Vitest suites.
///
/// Strategies: user records → last-write-wins by `updatedAt`, tombstone wins
/// ties; time-series → field-wise `max` (never sum); monotonic aggregates →
/// `max` per field; badges → union keeping the earliest unlock.
public enum SyncMerge {

    // MARK: id-addressable records (LWW + tombstones)

    private static func ts(_ r: SyncMeta) -> Millis { r.updatedAt ?? 0 }
    private static func isTombstone(_ r: SyncMeta) -> Bool { r.deletedAt != nil }

    /// Higher `updatedAt` wins; on a tie a tombstone beats a live record.
    public static func mergeRecord<T: SyncRecord>(_ local: T, _ remote: T) -> T {
        let lt = ts(local), rt = ts(remote)
        if rt > lt { return remote }
        if lt > rt { return local }
        if isTombstone(remote) && !isTombstone(local) { return remote }
        return local
    }

    /// Union two collections by `id`, reconciling overlaps. Preserves local
    /// order, then appends ids seen only on the remote. Tombstones are retained.
    public static func mergeById<T: SyncRecord>(_ local: [T], _ remote: [T]) -> [T] {
        var order: [String] = []
        var byId: [String: T] = [:]
        for r in local where byId[r.id] == nil { order.append(r.id); byId[r.id] = r }
        for r in remote {
            if let existing = byId[r.id] {
                byId[r.id] = mergeRecord(existing, r)
            } else {
                order.append(r.id); byId[r.id] = r
            }
        }
        return order.map { byId[$0]! }
    }

    /// Live (non-tombstoned) records, for read paths.
    public static func live<T: SyncRecord>(_ records: [T]) -> [T] {
        records.filter { !isTombstone($0) }
    }

    // MARK: aggregates

    private static func mx(_ a: Int?, _ b: Int?) -> Int { max(a ?? 0, b ?? 0) }

    /// Order-preserving union of two string sets (feeds).
    public static func mergeStringSet(_ local: [String], _ remote: [String]) -> [String] {
        var seen = Set(local)
        var out = local
        for s in remote where !seen.contains(s) { seen.insert(s); out.append(s) }
        return out
    }

    /// Field-wise max of two same-day DayStats.
    public static func mergeDayStats(_ a: DayStats, _ b: DayStats) -> DayStats {
        DayStats(
            minutes: max(a.minutes, b.minutes),
            sprints: max(a.sprints, b.sprints),
            articlesFinished: max(a.articlesFinished, b.articlesFinished),
            videosFinished: mx(a.videosFinished, b.videosFinished),
            focusBlocks: mx(a.focusBlocks, b.focusBlocks),
            tasksCompleted: mx(a.tasksCompleted, b.tasksCompleted)
        )
    }

    /// Per-key max of two `[String: Int]` maps.
    public static func mergeNumberMap(_ local: [String: Int], _ remote: [String: Int]) -> [String: Int] {
        var out = local
        for (k, v) in remote { out[k] = mx(out[k], v) }
        return out
    }

    /// Per-deck-key max of the two SRS sub-maps.
    public static func mergeSrsDayStats(_ a: SrsDayStats, _ b: SrsDayStats) -> SrsDayStats {
        SrsDayStats(
            reviews: mergeNumberMap(a.reviews, b.reviews),
            newIntroduced: mergeNumberMap(a.newIntroduced, b.newIntroduced)
        )
    }

    /// Merge two date-keyed maps using `mergeValue` for shared keys.
    public static func mergeDatedMap<V>(
        _ local: [String: V], _ remote: [String: V], _ mergeValue: (V, V) -> V
    ) -> [String: V] {
        var out = local
        for (day, v) in remote {
            out[day] = out[day].map { mergeValue($0, v) } ?? v
        }
        return out
    }

    /// Per-field max of lifetime counters.
    public static func mergeCounters(_ a: LifetimeCounters, _ b: LifetimeCounters) -> LifetimeCounters {
        LifetimeCounters(
            workouts: max(a.workouts, b.workouts),
            articlesFinished: max(a.articlesFinished, b.articlesFinished),
            videosFinished: max(a.videosFinished, b.videosFinished),
            sprints: max(a.sprints, b.sprints),
            tasksCompleted: max(a.tasksCompleted, b.tasksCompleted),
            brainDumps: max(a.brainDumps, b.brainDumps),
            focusBlocks: max(a.focusBlocks, b.focusBlocks),
            cardsReviewed: max(a.cardsReviewed, b.cardsReviewed),
            chestsOpened: mx(a.chestsOpened, b.chestsOpened)
        )
    }

    /// Union of two badge maps, keeping the earliest unlock per badge.
    public static func mergeBadges(_ local: [String: Millis], _ remote: [String: Millis]) -> [String: Millis] {
        var out = local
        for (id, at) in remote {
            out[id] = out[id].map { min($0, at) } ?? at
        }
        return out
    }

    /// Merge the singleton gamification doc: xp/counters max, badges union.
    public static func mergeGamification(_ a: Gamification, _ b: Gamification) -> Gamification {
        Gamification(
            xp: max(a.xp, b.xp),
            badges: mergeBadges(a.badges, b.badges),
            // Week keys are ISO 'YYYY-MM-DD' (Monday), so lexical max = latest.
            lastQuestCelebratedWeek: a.lastQuestCelebratedWeek >= b.lastQuestCelebratedWeek
                ? a.lastQuestCelebratedWeek : b.lastQuestCelebratedWeek,
            counters: mergeCounters(a.counters, b.counters)
        )
    }

    private static func earliestNonNull(_ a: Millis?, _ b: Millis?) -> Millis? {
        guard let a else { return b }
        guard let b else { return a }
        return min(a, b)
    }

    /// Merge two progress entries for the same URL. Metrics take the max; the
    /// earliest open/completion are kept; position fields come from the more
    /// recently updated record.
    public static func mergeProgress(_ local: MediaProgress, _ remote: MediaProgress) -> MediaProgress {
        var result = remote.updatedAt >= local.updatedAt ? remote : local
        result.maxPercent = max(local.maxPercent, remote.maxPercent)
        result.activeSeconds = max(local.activeSeconds, remote.activeSeconds)
        result.firstOpenedAt = min(local.firstOpenedAt, remote.firstOpenedAt)
        result.updatedAt = max(local.updatedAt, remote.updatedAt)
        result.completedAt = earliestNonNull(local.completedAt, remote.completedAt)
        result.nudge = Nudge(
            count: max(local.nudge.count, remote.nudge.count),
            lastAt: max(local.nudge.lastAt, remote.nudge.lastAt),
            dismissed: local.nudge.dismissed || remote.nudge.dismissed
        )
        return result
    }

    // MARK: tombstones

    /// Id-addressable collections that sync as `users/{uid}/{name}/{id}`.
    public static let recordCollections = [
        "tasks", "notes", "bookmarks", "bookmarkGroups",
        "decks", "flashNotes", "flashCards", "papers",
    ]

    public static func tombstoneKey(_ collection: String, _ id: String) -> String {
        "\(collection):\(id)"
    }

    /// Ids added/removed going from `before` to `after`.
    public static func diffIds<T: SyncRecord>(_ before: [T], _ after: [T]) -> (added: [String], removed: [String]) {
        let beforeIds = Set(before.map(\.id))
        let afterIds = Set(after.map(\.id))
        return (
            added: after.map(\.id).filter { !beforeIds.contains($0) },
            removed: before.map(\.id).filter { !afterIds.contains($0) }
        )
    }

    /// Union of two tombstone maps, keeping the latest deletion per key.
    public static func mergeTombstones(_ local: [String: Millis], _ remote: [String: Millis]) -> [String: Millis] {
        var out = local
        for (key, at) in remote { out[key] = max(out[key] ?? 0, at) }
        return out
    }

    /// Drop tombstones older than `ttlMs`.
    public static func sweepTombstoneMap(_ map: [String: Millis], now: Millis, ttlMs: Millis) -> [String: Millis] {
        map.filter { now - $0.value < ttlMs }
    }
}
