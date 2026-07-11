import Foundation

/// Models for the companion "library" surfaces — brain dump, papers, bookmarks.
/// All mirror their `types.ts` interfaces and round-trip with the same synced
/// collections the extension writes.

// MARK: - Brain dump

public struct ProposedTask: Codable, Equatable, Sendable {
    public var text: String
    /// Links a proposed task to the real Task it became; nil = not added.
    public var addedTaskId: String?
    public init(text: String, addedTaskId: String? = nil) {
        self.text = text; self.addedTaskId = addedTaskId
    }
}

public enum BrainDumpStatus: String, Codable, Sendable {
    case raw, structured, failed
}

public struct BrainDumpNote: SyncRecord, Sendable {
    public var id: String
    public var rawText: String
    /// `.raw` = saved but not yet AI-structured.
    public var status: BrainDumpStatus
    public var bullets: [String]
    public var proposedTasks: [ProposedTask]
    public var createdAt: Millis
    public var structuredAt: Millis?
    public var notionPushedAt: Millis?
    public var updatedAt: Millis?
    public var deletedAt: Millis?

    public init(
        id: String, rawText: String, status: BrainDumpStatus = .raw, bullets: [String] = [],
        proposedTasks: [ProposedTask] = [], createdAt: Millis, structuredAt: Millis? = nil,
        notionPushedAt: Millis? = nil, updatedAt: Millis? = nil, deletedAt: Millis? = nil
    ) {
        self.id = id; self.rawText = rawText; self.status = status; self.bullets = bullets
        self.proposedTasks = proposedTasks; self.createdAt = createdAt
        self.structuredAt = structuredAt; self.notionPushedAt = notionPushedAt
        self.updatedAt = updatedAt; self.deletedAt = deletedAt
    }
}

// MARK: - Papers

public enum PaperStatus: String, Codable, Sendable, CaseIterable {
    case toRead = "to-read", reading, read
}

public struct Paper: SyncRecord, Sendable {
    public var id: String
    /// Reuses a `Deck.id` (kind `.papers`).
    public var deckId: String
    public var title: String
    public var authors: String     // comma-joined
    public var venue: String
    public var year: Int?
    public var citations: Int?
    public var url: String
    public var abstract: String
    public var relevance: String   // why this paper matters to me
    public var status: PaperStatus
    public var progressPercent: Int
    public var leftOff: String
    public var addedAt: Millis
    public var lastReadAt: Millis?
    public var updatedAt: Millis?
    public var deletedAt: Millis?

    public init(
        id: String, deckId: String, title: String, authors: String = "", venue: String = "",
        year: Int? = nil, citations: Int? = nil, url: String = "", abstract: String = "",
        relevance: String = "", status: PaperStatus = .toRead, progressPercent: Int = 0,
        leftOff: String = "", addedAt: Millis, lastReadAt: Millis? = nil,
        updatedAt: Millis? = nil, deletedAt: Millis? = nil
    ) {
        self.id = id; self.deckId = deckId; self.title = title; self.authors = authors
        self.venue = venue; self.year = year; self.citations = citations; self.url = url
        self.abstract = abstract; self.relevance = relevance; self.status = status
        self.progressPercent = progressPercent; self.leftOff = leftOff; self.addedAt = addedAt
        self.lastReadAt = lastReadAt; self.updatedAt = updatedAt; self.deletedAt = deletedAt
    }
}

// MARK: - Reading progress

/// Per-article reading progress, sharded into a `readingProgress/{docId}`
/// collection (doc id = `UrlNormalize.progressDocId(url)`). iOS-owned for now —
/// the extension keeps its own local map and doesn't consume this yet, but the
/// streak/XP it drives flow through the shared `dayStats`/`gamification` docs.
public struct ReadingProgressRecord: SyncRecord, Sendable {
    public var id: String            // progressDocId(url)
    public var url: String
    public var title: String
    public var source: String
    public var feedItemId: String?
    public var maxPercent: Int
    public var scrollY: Double
    public var pageHeight: Double
    public var activeSeconds: Double
    public var firstOpenedAt: Millis
    public var completedAt: Millis?
    public var updatedAt: Millis?
    public var deletedAt: Millis?

    public init(
        id: String, url: String, title: String, source: String = "", feedItemId: String? = nil,
        maxPercent: Int = 0, scrollY: Double = 0, pageHeight: Double = 0, activeSeconds: Double = 0,
        firstOpenedAt: Millis, completedAt: Millis? = nil, updatedAt: Millis? = nil, deletedAt: Millis? = nil
    ) {
        self.id = id; self.url = url; self.title = title; self.source = source
        self.feedItemId = feedItemId; self.maxPercent = maxPercent; self.scrollY = scrollY
        self.pageHeight = pageHeight; self.activeSeconds = activeSeconds
        self.firstOpenedAt = firstOpenedAt; self.completedAt = completedAt
        self.updatedAt = updatedAt; self.deletedAt = deletedAt
    }
}

/// The completion threshold — an article is "finished" once maxPercent reaches
/// this (latched once). Matches the extension's COMPLETE_PERCENT.
public let readingCompletePercent = 90

// MARK: - Bookmarks

public struct BookmarkGroup: SyncRecord, Sendable {
    public var id: String
    public var name: String
    public var createdAt: Millis
    public var updatedAt: Millis?
    public var deletedAt: Millis?

    public init(
        id: String, name: String, createdAt: Millis,
        updatedAt: Millis? = nil, deletedAt: Millis? = nil
    ) {
        self.id = id; self.name = name; self.createdAt = createdAt
        self.updatedAt = updatedAt; self.deletedAt = deletedAt
    }
}

public struct BookmarkLink: SyncRecord, Sendable {
    public var id: String
    public var url: String
    public var title: String
    /// nil renders under "Unsorted".
    public var groupId: String?
    public var createdAt: Millis
    public var updatedAt: Millis?
    public var deletedAt: Millis?

    public init(
        id: String, url: String, title: String, groupId: String? = nil, createdAt: Millis,
        updatedAt: Millis? = nil, deletedAt: Millis? = nil
    ) {
        self.id = id; self.url = url; self.title = title; self.groupId = groupId
        self.createdAt = createdAt; self.updatedAt = updatedAt; self.deletedAt = deletedAt
    }
}
