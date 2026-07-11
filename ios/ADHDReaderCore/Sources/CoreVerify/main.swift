import Foundation
import ADHDReaderCore

// Lightweight behavioral verification for ADHDReaderCore, runnable under the
// Command Line Tools toolchain (which lacks XCTest/swift-testing). Mirrors the
// extension's Vitest suites for merge.ts, collections.ts, and srs.ts. Exits
// non-zero on any failure so it can gate CI.

var failures = 0
var checks = 0
func check(_ cond: Bool, _ label: String, file: StaticString = #file, line: UInt = #line) {
    checks += 1
    if !cond { failures += 1; print("  ✗ \(label)  (\(file):\(line))") }
}

// MARK: helpers

func task(_ id: String, text: String? = nil, updatedAt: Millis? = 1000, deletedAt: Millis? = nil) -> TaskItem {
    TaskItem(id: id, text: text ?? id, createdAt: 1000, source: .popup, updatedAt: updatedAt, deletedAt: deletedAt)
}

func progress(_ over: (inout MediaProgress) -> Void) -> MediaProgress {
    var p = MediaProgress(kind: "article", url: "https://example.com/a", title: "A", source: "Feed",
                     maxPercent: 0, activeSeconds: 0, firstOpenedAt: 1000, updatedAt: 1000,
                     feedItemId: nil, scrollY: 0, pageHeight: 0)
    over(&p)
    return p
}

let MIN = 60_000
let DAY = 86_400_000
let NOW: Millis = Int(
    Calendar.current.date(from: DateComponents(year: 2026, month: 7, day: 5, hour: 12))!
        .timeIntervalSince1970 * 1000)

func fresh(_ over: (inout FlashCard) -> Void = { _ in }) -> FlashCard {
    var c = SRS.newCard(noteId: "n1", deckId: "d1", variant: 0, now: NOW)
    over(&c)
    return c
}
func reviewCard(_ intervalDays: Int, ease: Double = 2.5, _ over: (inout FlashCard) -> Void = { _ in }) -> FlashCard {
    fresh { $0.phase = .review; $0.intervalDays = intervalDays; $0.ease = ease; $0.dueAt = NOW; over(&$0) }
}

/// Deterministic rand source for chest rolls.
func seqRand(_ values: [Double]) -> () -> Double {
    var i = 0
    return { defer { i += 1 }; return values[i] }
}

func note(_ id: String, type: FlashNoteType = .basic, front: String = "f", reversed: Bool = false) -> FlashNote {
    FlashNote(id: id, deckId: "d1", type: type, front: front, back: "b", reversed: reversed, createdAt: NOW)
}

// MARK: SyncMerge

print("SyncMerge")

do {
    let a = task("t1", text: "old", updatedAt: 100)
    let b = task("t1", text: "new", updatedAt: 200)
    check(SyncMerge.mergeRecord(a, b).text == "new", "higher updatedAt wins")
    check(SyncMerge.mergeRecord(b, a).text == "new", "higher updatedAt wins (commutative)")

    let live = task("t1", updatedAt: 200)
    let dead = task("t1", updatedAt: 200, deletedAt: 200)
    check(SyncMerge.mergeRecord(live, dead).deletedAt == 200, "tombstone wins tie")
    check(SyncMerge.mergeRecord(dead, live).deletedAt == 200, "tombstone wins tie (commutative)")

    let deadOld = task("t1", updatedAt: 100, deletedAt: 100)
    let edit = task("t1", updatedAt: 200, deletedAt: nil)
    check(SyncMerge.mergeRecord(deadOld, edit).deletedAt == nil, "newer edit beats older tombstone")

    let legacy = task("t1", text: "legacy", updatedAt: nil)
    let synced = task("t1", text: "synced", updatedAt: 1)
    check(SyncMerge.mergeRecord(legacy, synced).text == "synced", "missing updatedAt loses")
}

do {
    let merged = SyncMerge.mergeById(
        [task("a", text: "a-local", updatedAt: 1), task("b")],
        [task("a", text: "a-remote", updatedAt: 2), task("c")])
    check(merged.map(\.id).sorted() == ["a", "b", "c"], "mergeById unions ids")
    check(merged.first { $0.id == "a" }?.text == "a-remote", "mergeById reconciles overlap")

    let withTomb = SyncMerge.mergeById([task("a")], [task("a", updatedAt: 2000, deletedAt: 2000)])
    check(withTomb.count == 1 && withTomb[0].deletedAt == 2000, "mergeById retains tombstone")
    check(SyncMerge.live(withTomb).isEmpty, "live() excludes tombstones")
}

do {
    check(SyncMerge.mergeStringSet(["a", "b"], ["b", "c"]) == ["a", "b", "c"], "mergeStringSet unions")

    let day = SyncMerge.mergeDayStats(
        DayStats(minutes: 10, sprints: 2, articlesFinished: 1),
        DayStats(minutes: 5, sprints: 3, articlesFinished: 0, videosFinished: 2))
    check(day == DayStats(minutes: 10, sprints: 3, articlesFinished: 1,
                          videosFinished: 2, focusBlocks: 0, tasksCompleted: 0), "mergeDayStats field-wise max")

    check(SyncMerge.mergeNumberMap(["d1": 3, "d2": 1], ["d1": 2, "d3": 5]) == ["d1": 3, "d2": 1, "d3": 5],
          "mergeNumberMap per-key max")

    let srs = SyncMerge.mergeSrsDayStats(
        SrsDayStats(reviews: ["d1": 5], newIntroduced: ["d1": 2]),
        SrsDayStats(reviews: ["d1": 3, "d2": 1], newIntroduced: ["d1": 4]))
    check(srs.reviews == ["d1": 5, "d2": 1] && srs.newIntroduced == ["d1": 4], "mergeSrsDayStats")

    let dated = SyncMerge.mergeDatedMap(
        ["2026-07-08": DayStats(minutes: 5, sprints: 1), "2026-07-09": DayStats(minutes: 10, articlesFinished: 1)],
        ["2026-07-09": DayStats(minutes: 3, sprints: 2, articlesFinished: 2), "2026-07-10": DayStats(minutes: 8, sprints: 1)],
        SyncMerge.mergeDayStats)
    check(Set(dated.keys) == ["2026-07-08", "2026-07-09", "2026-07-10"], "mergeDatedMap keys")
    check(dated["2026-07-09"]?.minutes == 10 && dated["2026-07-09"]?.sprints == 2, "mergeDatedMap merges shared day")

    let counters = SyncMerge.mergeCounters(
        LifetimeCounters(workouts: 3, sprints: 10),
        LifetimeCounters(workouts: 5, sprints: 6, tasksCompleted: 2))
    check(counters.workouts == 5 && counters.sprints == 10 && counters.tasksCompleted == 2, "mergeCounters max")

    check(SyncMerge.mergeBadges(["first": 500, "only_a": 1], ["first": 300, "only_b": 2])
          == ["first": 300, "only_a": 1, "only_b": 2], "mergeBadges earliest unlock")

    let game = SyncMerge.mergeGamification(
        Gamification(xp: 100, badges: ["x": 10], lastQuestCelebratedWeek: "2026-07-06", counters: LifetimeCounters(sprints: 4)),
        Gamification(xp: 80, badges: ["y": 20], lastQuestCelebratedWeek: "2026-06-29", counters: LifetimeCounters(sprints: 6)))
    check(game.xp == 100 && game.counters.sprints == 6 && game.badges == ["x": 10, "y": 20]
          && game.lastQuestCelebratedWeek == "2026-07-06", "mergeGamification")
}

do {
    let a = progress { $0.maxPercent = 40; $0.activeSeconds = 30; $0.firstOpenedAt = 500; $0.updatedAt = 500 }
    let b = progress { $0.maxPercent = 70; $0.activeSeconds = 20; $0.firstOpenedAt = 900; $0.updatedAt = 900; $0.completedAt = 950 }
    let m = SyncMerge.mergeProgress(a, b)
    check(m.maxPercent == 70 && m.activeSeconds == 30 && m.firstOpenedAt == 500 && m.updatedAt == 900 && m.completedAt == 950,
          "mergeProgress maxes metrics / earliest open+completion")

    let older = progress { $0.updatedAt = 100; $0.scrollY = 10 }
    let newer = progress { $0.updatedAt = 200; $0.scrollY = 999 }
    check(SyncMerge.mergeProgress(older, newer).scrollY == 999 && SyncMerge.mergeProgress(newer, older).scrollY == 999,
          "mergeProgress position from newer")

    let na = progress { $0.nudge = Nudge(count: 1, lastAt: 5, dismissed: false) }
    let nb = progress { $0.nudge = Nudge(count: 2, lastAt: 3, dismissed: true) }
    check(SyncMerge.mergeProgress(na, nb).nudge == Nudge(count: 2, lastAt: 5, dismissed: true), "mergeProgress nudge OR/max")
}

do {
    check(SyncMerge.tombstoneKey("tasks", "abc") == "tasks:abc", "tombstoneKey")
    check(SyncMerge.tombstoneKey("flashCards", "n1#0") == "flashCards:n1#0", "tombstoneKey with '#'")

    let diff = SyncMerge.diffIds([task("a"), task("b"), task("c")], [task("a"), task("c"), task("d")])
    check(diff.added == ["d"] && diff.removed == ["b"], "diffIds")

    check(SyncMerge.mergeTombstones(["tasks:a": 100, "tasks:b": 5], ["tasks:a": 80, "tasks:c": 9])
          == ["tasks:a": 100, "tasks:b": 5, "tasks:c": 9], "mergeTombstones latest wins")

    let now = 1_000_000
    check(SyncMerge.sweepTombstoneMap(["tasks:old": now - 200, "tasks:fresh": now - 50], now: now, ttlMs: 100)
          == ["tasks:fresh": now - 50], "sweepTombstoneMap")
}

// MARK: SRS

print("SRS")

do {
    let c = SRS.newCard(noteId: "n1", deckId: "d1", variant: 0, now: NOW)
    check(c.id == "n1#0" && c.phase == .new && c.ease == 2.5 && c.dueAt == NOW, "newCard defaults")

    let good = SRS.answerCard(fresh(), .good, now: NOW)
    check(good.phase == .learning && good.stepIndex == 1 && good.dueAt == NOW + 10 * MIN && good.reps == 1,
          "new + good enters learning")

    let again = SRS.answerCard(fresh(), .again, now: NOW)
    check(again.phase == .learning && again.stepIndex == 0 && again.dueAt == NOW + 1 * MIN, "new + again restarts")

    let easy = SRS.answerCard(fresh(), .easy, now: NOW)
    check(easy.phase == .review && easy.intervalDays == 4 && easy.dueAt == NOW + 4 * DAY, "new + easy graduates")

    let grad = SRS.answerCard(fresh { $0.phase = .learning; $0.stepIndex = 1 }, .good, now: NOW)
    check(grad.phase == .review && grad.intervalDays == 1 && grad.dueAt == NOW + 1 * DAY, "learning last step graduates")

    let revGood = SRS.answerCard(reviewCard(10, ease: 2.5), .good, now: NOW)
    check(revGood.intervalDays == 25 && revGood.dueAt == NOW + 25 * DAY, "review + good = interval * ease")

    let lapse = SRS.answerCard(reviewCard(20, ease: 2.5), .again, now: NOW)
    check(lapse.phase == .relearning && abs(lapse.ease - 2.3) < 0.0001 && lapse.lapses == 1
          && lapse.intervalDays == 1 && lapse.dueAt == NOW + 10 * MIN, "review + again lapses")

    let hard = SRS.answerCard(reviewCard(10, ease: 2.5), .hard, now: NOW)
    check(abs(hard.ease - 2.35) < 0.0001 && hard.intervalDays == 12, "review + hard reduces ease")
}

do {
    check(SRS.formatInterval(1 * MIN) == "1m", "formatInterval 1m")
    check(SRS.formatInterval(30 * MIN) == "30m", "formatInterval 30m")
    check(SRS.formatInterval(3 * 3_600_000) == "3h", "formatInterval 3h")
    check(SRS.formatInterval(2 * DAY) == "2d", "formatInterval 2d")
    check(SRS.formatInterval(45 * DAY) == "1.5mo", "formatInterval 1.5mo")
    check(SRS.formatInterval(400 * DAY) == "1.1yr", "formatInterval 1.1yr")

    check(Set(SRS.previewIntervals(fresh(), now: NOW).keys) == Set(Rating.allCases), "previewIntervals all ratings")

    let learn = fresh { $0.id = "n2#0"; $0.noteId = "n2"; $0.phase = .learning; $0.dueAt = NOW - MIN }
    let newer = fresh { $0.id = "n3#0"; $0.noteId = "n3"; $0.createdAt = NOW }
    let queue = SRS.buildQueue([newer, learn], deckId: "d1", now: NOW, newIntroducedToday: 0)
    check(queue.first?.id == "n2#0" && queue.count == 2, "buildQueue orders learning before new")

    let cards = (0..<25).map { i in fresh { $0.id = "n\(i)#0"; $0.noteId = "n\(i)" } }
    check(SRS.dueCounts(cards, now: NOW, newIntroducedByDeck: ["d1": 5])["d1"]?.newCount == 15,
          "dueCounts respects new allowance")

    let graduated = fresh { $0.phase = .review }
    check(SRS.isRewardableAnswer(prevPhase: .review, next: graduated), "rewardable: review→")
    check(SRS.isRewardableAnswer(prevPhase: .new, next: graduated), "rewardable: new→review")
    check(!SRS.isRewardableAnswer(prevPhase: .new, next: fresh { $0.phase = .learning }), "not rewardable: new→learning")
}

// MARK: Levels

print("Levels")
do {
    check(Levels.xpForLevel(2) == 100 && Levels.xpForLevel(3) == 300, "xpForLevel L2/L3")
    check(Levels.xpForLevel(5) == 1000 && Levels.xpForLevel(10) == 4500, "xpForLevel L5/L10")
    check(Levels.levelForXp(0) == Levels.LevelInfo(level: 1, intoLevel: 0, toNext: 100), "levelForXp 0")
    check(Levels.levelForXp(150) == Levels.LevelInfo(level: 2, intoLevel: 50, toNext: 200), "levelForXp 150")
    check(Levels.xpValues[.focusBlock] == 25 && Levels.xpValues[.taskCompleted] == 5, "xpValues")
}

// MARK: Chests

print("Chests")
do {
    check(Chests.rollChest(seqRand([0.2])) == nil, "no drop above rate")
    check(Chests.rollChest(seqRand([0.1, 0.0])) == 10, "drop tier 10")
    check(Chests.rollChest(seqRand([0.1, 0.8])) == 25, "drop tier 25")
    check(Chests.rollChest(seqRand([0.1, 0.97])) == 50, "drop tier 50")
}

// MARK: Week

print("Week")
do {
    check(Week.weekDates("2026-07-06") == ["2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-11", "2026-07-12"], "weekDates 7 consecutive")
    check(Week.prevWeekKey("2026-07-06") == "2026-06-29", "prevWeekKey minus 7 days")
    check(Week.countInWeek(["2026-07-08": 1, "2026-07-10": 1, "2026-08-01": 1], "2026-07-06") == 2, "countInWeek")
    let wed = DateUtil.parseLocalDate("2026-07-08")!
    let wk = Week.weekKey(wed)
    check(Week.weekDates(wk).count == 7 && Week.weekDates(wk).first == wk, "weekKey is a Monday")
    check(Week.weekDates(wk).contains("2026-07-08"), "weekKey week contains its date")
}

// MARK: StreakInsurance

print("StreakInsurance")
do {
    check(StreakInsurance.missedDays("2026-07-05", "2026-07-08") == 2, "missedDays gap")
    check(StreakInsurance.missedDays("2026-07-07", "2026-07-08") == 0, "missedDays adjacent")

    var s = Streaks(currentStreak: 5, lastQualifiedDate: "2026-07-05", freezeTokens: 3)
    let r = StreakInsurance.bridgeGap(&s, today: "2026-07-08")
    check(r.bridged && r.tokensSpent == 2 && s.freezeTokens == 1 && s.lastQualifiedDate == "2026-07-07", "bridgeGap spends tokens")

    var s2 = Streaks(currentStreak: 5, freezeTokens: 0)
    check(StreakInsurance.maybeEarnToken(&s2) && s2.freezeTokens == 1, "maybeEarnToken on 5th day")
    var s3 = Streaks(currentStreak: 3)
    check(!StreakInsurance.maybeEarnToken(&s3), "no token off-cadence")
}

// MARK: Quest

print("Quest")
do {
    let settings = QuestSettings(gymWeeklyTarget: 1, questArticlesPerWeek: 1, questSprintsPerWeek: 1,
                                 questVideosPerWeek: 1, questFocusPerWeek: 0)
    let daily = ["2026-07-06": DayStats(sprints: 1, articlesFinished: 1)]
    let p = Quest.progress(checkins: ["2026-07-06": 1], daily: daily, settings: settings, week: "2026-07-06")
    check(p.lines.count == 4, "quest drops zero-target lines")
    check(!p.complete, "quest incomplete when a line unmet")

    let metSettings = QuestSettings(gymWeeklyTarget: 1, questArticlesPerWeek: 1, questSprintsPerWeek: 1,
                                    questVideosPerWeek: 0, questFocusPerWeek: 0)
    let p2 = Quest.progress(checkins: ["2026-07-06": 1], daily: daily, settings: metSettings, week: "2026-07-06")
    check(p2.lines.count == 3 && p2.complete, "quest complete when all met")
}

// MARK: Badges

print("Badges")
do {
    let firstWorkout = Badges.all.first { $0.id == "first-workout" }!
    check(firstWorkout.earned(StatsSnapshot(workouts: 1)), "first-workout earned")
    check(!firstWorkout.earned(StatsSnapshot(workouts: 0)), "first-workout not earned")
    let level5 = Badges.all.first { $0.id == "level-5" }!
    check(level5.earned(StatsSnapshot(level: 5)) && !level5.earned(StatsSnapshot(level: 4)), "level-5 threshold")
    check(Badges.all.count == 24, "badge catalog size")
}

// MARK: Cloze

print("Cloze")
do {
    check(Cloze.clozeIndexes("{{c1::a}} {{c2::b}} {{c1::c}}") == [1, 2], "clozeIndexes distinct sorted")
    check(Cloze.clozeIndexes("no clozes") == [], "clozeIndexes none")
    check(Cloze.clozeText("{{c1::a}} and {{c2::b}}", activeIndex: 1, side: "front") == "[...] and b", "cloze front blanks active")
    check(Cloze.clozeText("{{c1::a}} and {{c2::b}}", activeIndex: 1, side: "back") == "a and b", "cloze back shows answer")
    check(Cloze.clozeText("{{c1::a::hint}}", activeIndex: 1, side: "front") == "[hint]", "cloze hint")
}

// MARK: SRS cards

print("SRS cards")
do {
    check(SRS.cardsForNote(note("n1", reversed: true)) == [0, 1], "basic reversed → 2 cards")
    check(SRS.cardsForNote(note("n1", reversed: false)) == [0], "basic → 1 card")
    check(SRS.cardsForNote(note("n1", type: .cloze, front: "{{c1::x}}{{c2::y}}")) == [1, 2], "cloze note variants")

    let existing = [fresh { $0.id = "n1#0"; $0.reps = 5 }]
    let reconciled = SRS.reconcileCards(note("n1", reversed: true), existing: existing, now: NOW)
    check(reconciled.count == 2, "reconcile adds new variant")
    check(reconciled.first { $0.variant == 0 }?.reps == 5, "reconcile keeps existing scheduling")
    check(reconciled.first { $0.variant == 1 }?.reps == 0, "reconcile starts new variant fresh")
}

// MARK: Activity

print("Activity")
do {
    let score = Activity.dayActivityScore(Activity.DayParts(minutes: 30, gym: true, cardsReviewed: 25, tasks: 2))
    check(score == 7, "dayActivityScore normalizes") // 2 tasks + 2 (30/15) + 1 gym + 2 (25/10)
    check(Activity.activityLevel(0, max: 10) == 0, "level 0 for no activity")
    check(Activity.activityLevel(10, max: 10) == 4, "level 4 at max")
    check(Activity.activityLevel(1, max: 10) == 1, "any nonzero ≥ level 1")
    check(Activity.activityLevel(6, max: 10) == 3, "level quartile")

    // buildActivityDays — would trap on the Int.min month-label underflow.
    let model = Activity.buildActivityDays(
        streaksDaily: ["2026-07-09": DayStats(minutes: 30, sprints: 1, articlesFinished: 2)],
        gymCheckins: ["2026-07-08": 1],
        srsDaily: ["2026-07-10": SrsDayStats(reviews: ["d": 20])],
        todayKey: "2026-07-10")
    check(model.weeks.count == 53, "calendar has 53 week columns")
    check(model.weeks.allSatisfy { $0.count == 7 }, "each column is 7 days")
    check(!model.monthLabels.isEmpty, "month labels emitted (no Int.min underflow)")
    check(model.totalActivities > 0, "activity totalled across sources")
    let streak = Activity.currentActivityStreak(model, todayKey: "2026-07-10")
    check(streak >= 1, "today's 2 card-review-derived activity counts as streak") // 20 reviews → 2
}

// MARK: UrlNormalize + ReadingStreak

print("Reader")
do {
    check(UrlNormalize.normalize("https://www.Example.com/path/?utm_source=x&b=2&a=1#frag")
          == "example.com/path?a=1&b=2", "normalize strips www/scheme/tracking/hash, sorts query")
    check(UrlNormalize.normalize("http://example.com/") == "example.com/", "root path stays '/'")
    check(UrlNormalize.normalize("https://EXAMPLE.com/A/B/") == "example.com/A/B", "trailing slash trimmed, host lowercased")
    check(UrlNormalize.itemId(link: "https://x.com/a", title: "Hello").count <= 32, "itemId ≤ 32 chars")
    check(!UrlNormalize.progressDocId("https://x.com/a?b=1").contains("/"), "progress doc id has no slash")

    let daily: [String: DayStats] = [
        "2026-07-10": DayStats(minutes: 8),
        "2026-07-09": DayStats(minutes: 6),
        "2026-07-08": DayStats(minutes: 0, sprints: 1),
        "2026-07-06": DayStats(minutes: 10),  // gap on the 7th breaks it
    ]
    check(ReadingStreak.current(daily, todayKey: "2026-07-10", goalMinutes: 5) == 3, "streak counts 3 consecutive qualifying days")
    check(ReadingStreak.current(daily, todayKey: "2026-07-10", goalMinutes: 20) == 0, "no day qualifies at a higher goal")
    // today not yet qualified but yesterday did → streak still alive from yesterday
    let daily2: [String: DayStats] = ["2026-07-09": DayStats(minutes: 6), "2026-07-08": DayStats(minutes: 7)]
    check(ReadingStreak.current(daily2, todayKey: "2026-07-10", goalMinutes: 5) == 2, "streak alive through yesterday")

    // Gym week streak: target 3/week. Weeks of 2026-07-06 and 2026-06-29 each hit 3.
    let checkins = [
        "2026-07-06": 1, "2026-07-08": 1, "2026-07-10": 1,   // this week (Mon 07-06): 3 ✓
        "2026-06-29": 1, "2026-06-30": 1, "2026-07-01": 1,   // last week (Mon 06-29): 3 ✓
    ]
    check(GymStreak.current(checkins, thisWeek: "2026-07-06", target: 3) == 2, "gym streak counts 2 qualified weeks")
    check(GymStreak.current(checkins, thisWeek: "2026-07-06", target: 4) == 0, "no week qualifies at target 4")
}

// MARK: summary

print("\n\(checks - failures)/\(checks) checks passed")
if failures > 0 {
    print("FAILED: \(failures) check(s)")
    exit(1)
}
print("ALL PASS")
