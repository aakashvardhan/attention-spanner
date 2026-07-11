import Foundation

/// Millisecond epoch timestamp, matching the extension's JS `number` times.
public typealias Millis = Int

/// Cloud-sync metadata carried by every user-authored, synced record.
/// Mirrors `SyncMeta` in src/shared/types.ts. `updatedAt` drives last-write-wins;
/// a non-nil `deletedAt` is a tombstone.
public protocol SyncMeta {
    var updatedAt: Millis? { get }
    var deletedAt: Millis? { get }
}

/// An id-addressable, user-authored synced record (tasks, cards, papers, …).
public protocol SyncRecord: SyncMeta, Codable, Equatable {
    var id: String { get }
}

// MARK: - Tasks

public enum TaskSource: String, Codable, Sendable {
    case capture, popup, newtab, braindump
}

/// A to-do item. Named `TaskItem` (not `Task`) to avoid colliding with Swift
/// Concurrency's `Task`. Codable maps by field name, so this round-trips with
/// the extension's `tasks` collection regardless of the Swift type name.
public struct TaskItem: SyncRecord, Sendable {
    public var id: String
    public var text: String
    public var createdAt: Millis
    public var completedAt: Millis?
    public var snoozedUntil: Millis?
    public var source: TaskSource
    public var notionPageId: String?
    public var updatedAt: Millis?
    public var deletedAt: Millis?

    public init(
        id: String, text: String, createdAt: Millis, completedAt: Millis? = nil,
        snoozedUntil: Millis? = nil, source: TaskSource = .popup, notionPageId: String? = nil,
        updatedAt: Millis? = nil, deletedAt: Millis? = nil
    ) {
        self.id = id; self.text = text; self.createdAt = createdAt
        self.completedAt = completedAt; self.snoozedUntil = snoozedUntil
        self.source = source; self.notionPageId = notionPageId
        self.updatedAt = updatedAt; self.deletedAt = deletedAt
    }
}

// MARK: - Flashcards (SM-2)

public enum CardPhase: String, Codable, Sendable {
    case new, learning, review, relearning
}

public enum Rating: String, Codable, Sendable, CaseIterable {
    case again, hard, good, easy
}

public enum DeckKind: String, Codable, Sendable {
    case flashcards, papers
}

/// A deck of flashcards (kind `.flashcards`) or tracked papers (kind `.papers`).
/// Mirrors `Deck` in types.ts. `kind` defaults to `.flashcards` when absent so
/// decks synced from a pre-`kind` profile still decode.
public struct Deck: SyncRecord, Sendable {
    public var id: String
    public var name: String
    public var createdAt: Millis
    public var kind: DeckKind
    public var updatedAt: Millis?
    public var deletedAt: Millis?

    public init(
        id: String, name: String, createdAt: Millis, kind: DeckKind = .flashcards,
        updatedAt: Millis? = nil, deletedAt: Millis? = nil
    ) {
        self.id = id; self.name = name; self.createdAt = createdAt; self.kind = kind
        self.updatedAt = updatedAt; self.deletedAt = deletedAt
    }

    enum CodingKeys: String, CodingKey {
        case id, name, createdAt, kind, updatedAt, deletedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        createdAt = try c.decode(Millis.self, forKey: .createdAt)
        kind = try c.decodeIfPresent(DeckKind.self, forKey: .kind) ?? .flashcards
        updatedAt = try c.decodeIfPresent(Millis.self, forKey: .updatedAt)
        deletedAt = try c.decodeIfPresent(Millis.self, forKey: .deletedAt)
    }
}

public enum FlashNoteType: String, Codable, Sendable {
    case basic, cloze
}

public struct FlashNote: SyncRecord, Sendable {
    public var id: String
    public var deckId: String
    public var type: FlashNoteType
    public var front: String
    public var back: String
    public var reversed: Bool
    public var createdAt: Millis
    public var updatedAt: Millis?
    public var deletedAt: Millis?

    public init(
        id: String, deckId: String, type: FlashNoteType, front: String, back: String,
        reversed: Bool, createdAt: Millis, updatedAt: Millis? = nil, deletedAt: Millis? = nil
    ) {
        self.id = id; self.deckId = deckId; self.type = type; self.front = front
        self.back = back; self.reversed = reversed; self.createdAt = createdAt
        self.updatedAt = updatedAt; self.deletedAt = deletedAt
    }
}

public struct FlashCard: SyncRecord, Sendable {
    public var id: String
    public var noteId: String
    public var deckId: String
    public var variant: Int
    public var phase: CardPhase
    public var stepIndex: Int
    public var ease: Double
    public var intervalDays: Int
    public var dueAt: Millis
    public var lapses: Int
    public var reps: Int
    public var createdAt: Millis
    public var updatedAt: Millis?
    public var deletedAt: Millis?

    public init(
        id: String, noteId: String, deckId: String, variant: Int, phase: CardPhase,
        stepIndex: Int, ease: Double, intervalDays: Int, dueAt: Millis, lapses: Int,
        reps: Int, createdAt: Millis, updatedAt: Millis? = nil, deletedAt: Millis? = nil
    ) {
        self.id = id; self.noteId = noteId; self.deckId = deckId; self.variant = variant
        self.phase = phase; self.stepIndex = stepIndex; self.ease = ease
        self.intervalDays = intervalDays; self.dueAt = dueAt; self.lapses = lapses
        self.reps = reps; self.createdAt = createdAt
        self.updatedAt = updatedAt; self.deletedAt = deletedAt
    }
}

public struct SrsDayStats: Codable, Equatable, Sendable {
    /// deckId → cards answered that day
    public var reviews: [String: Int]
    /// deckId → new cards introduced that day
    public var newIntroduced: [String: Int]

    public init(reviews: [String: Int] = [:], newIntroduced: [String: Int] = [:]) {
        self.reviews = reviews; self.newIntroduced = newIntroduced
    }
}

// MARK: - Streaks / gamification aggregates

public struct DayStats: Codable, Equatable, Sendable {
    public var minutes: Double
    public var sprints: Int
    public var articlesFinished: Int
    public var videosFinished: Int?
    public var focusBlocks: Int?
    public var tasksCompleted: Int?

    public init(
        minutes: Double = 0, sprints: Int = 0, articlesFinished: Int = 0,
        videosFinished: Int? = nil, focusBlocks: Int? = nil, tasksCompleted: Int? = nil
    ) {
        self.minutes = minutes; self.sprints = sprints; self.articlesFinished = articlesFinished
        self.videosFinished = videosFinished; self.focusBlocks = focusBlocks
        self.tasksCompleted = tasksCompleted
    }
}

public struct LifetimeCounters: Codable, Equatable, Sendable {
    public var workouts: Int
    public var articlesFinished: Int
    public var videosFinished: Int
    public var sprints: Int
    public var tasksCompleted: Int
    public var brainDumps: Int
    public var focusBlocks: Int
    public var cardsReviewed: Int
    public var chestsOpened: Int?

    public init(
        workouts: Int = 0, articlesFinished: Int = 0, videosFinished: Int = 0, sprints: Int = 0,
        tasksCompleted: Int = 0, brainDumps: Int = 0, focusBlocks: Int = 0, cardsReviewed: Int = 0,
        chestsOpened: Int? = nil
    ) {
        self.workouts = workouts; self.articlesFinished = articlesFinished
        self.videosFinished = videosFinished; self.sprints = sprints
        self.tasksCompleted = tasksCompleted; self.brainDumps = brainDumps
        self.focusBlocks = focusBlocks; self.cardsReviewed = cardsReviewed
        self.chestsOpened = chestsOpened
    }
}

public struct Streaks: Codable, Equatable, Sendable {
    public var currentStreak: Int
    public var longestStreak: Int
    /// Local date 'YYYY-MM-DD'
    public var lastQualifiedDate: String
    /// Keyed by local date 'YYYY-MM-DD'
    public var daily: [String: DayStats]
    public var freezeTokens: Int?

    public init(
        currentStreak: Int = 0, longestStreak: Int = 0, lastQualifiedDate: String = "",
        daily: [String: DayStats] = [:], freezeTokens: Int? = nil
    ) {
        self.currentStreak = currentStreak; self.longestStreak = longestStreak
        self.lastQualifiedDate = lastQualifiedDate; self.daily = daily
        self.freezeTokens = freezeTokens
    }
}

public struct Gamification: Codable, Equatable, Sendable {
    public var xp: Int
    /// badgeId → unlockedAt (ms)
    public var badges: [String: Millis]
    public var lastQuestCelebratedWeek: String
    public var counters: LifetimeCounters

    public init(
        xp: Int = 0, badges: [String: Millis] = [:], lastQuestCelebratedWeek: String = "",
        counters: LifetimeCounters = LifetimeCounters()
    ) {
        self.xp = xp; self.badges = badges
        self.lastQuestCelebratedWeek = lastQuestCelebratedWeek; self.counters = counters
    }
}

// MARK: - Reading / video progress

public struct Nudge: Codable, Equatable, Sendable {
    public var count: Int
    public var lastAt: Millis
    public var dismissed: Bool

    public init(count: Int = 0, lastAt: Millis = 0, dismissed: Bool = false) {
        self.count = count; self.lastAt = lastAt; self.dismissed = dismissed
    }
}

/// Unified reading/video progress (mirrors the `AnyProgress` union). `kind`
/// distinguishes the two; type-specific fields are optional. Named to avoid a
/// clash with Foundation's `Progress` (NSProgress).
public struct MediaProgress: Codable, Equatable, Sendable {
    public var kind: String // "article" | "video"
    public var url: String
    public var title: String
    public var source: String
    public var maxPercent: Int
    public var activeSeconds: Double
    public var firstOpenedAt: Millis
    public var updatedAt: Millis
    public var completedAt: Millis?
    public var nudge: Nudge
    // Article-only
    public var feedItemId: String?
    public var scrollY: Double?
    public var pageHeight: Double?
    // Video-only
    public var videoId: String?
    public var durationSeconds: Double?
    public var positionSeconds: Double?

    public init(
        kind: String, url: String, title: String, source: String, maxPercent: Int,
        activeSeconds: Double, firstOpenedAt: Millis, updatedAt: Millis, completedAt: Millis? = nil,
        nudge: Nudge = Nudge(), feedItemId: String? = nil, scrollY: Double? = nil,
        pageHeight: Double? = nil, videoId: String? = nil, durationSeconds: Double? = nil,
        positionSeconds: Double? = nil
    ) {
        self.kind = kind; self.url = url; self.title = title; self.source = source
        self.maxPercent = maxPercent; self.activeSeconds = activeSeconds
        self.firstOpenedAt = firstOpenedAt; self.updatedAt = updatedAt
        self.completedAt = completedAt; self.nudge = nudge; self.feedItemId = feedItemId
        self.scrollY = scrollY; self.pageHeight = pageHeight; self.videoId = videoId
        self.durationSeconds = durationSeconds; self.positionSeconds = positionSeconds
    }
}
