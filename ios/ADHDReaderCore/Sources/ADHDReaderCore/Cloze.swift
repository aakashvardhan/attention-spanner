import Foundation

/// Cloze deletion parsing — Anki syntax {{c1::answer}} or {{c1::answer::hint}}.
/// Ported from `src/shared/cloze.ts`.
public enum Cloze {
    // {{c(\d+)::(answer)(?:::(hint))?}}
    static let regex = try! NSRegularExpression(
        pattern: #"\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}"#)

    private static func matches(in text: String) -> [NSTextCheckingResult] {
        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: range)
    }

    private static func group(_ match: NSTextCheckingResult, _ i: Int, in text: String) -> String? {
        let r = match.range(at: i)
        guard r.location != NSNotFound, let range = Range(r, in: text) else { return nil }
        return String(text[range])
    }

    /// Distinct cloze indexes in the text, sorted ascending. [] = not a valid cloze note.
    public static func clozeIndexes(_ text: String) -> [Int] {
        var indexes = Set<Int>()
        for m in matches(in: text) {
            if let s = group(m, 1, in: text), let index = Int(s), index >= 1 { indexes.insert(index) }
        }
        return indexes.sorted()
    }

    public struct Segment: Equatable, Sendable {
        public let text: String
        public let clozeIndex: Int?
        public let clozeActive: Bool?
    }

    /// Split cloze text into renderable segments for one card (`activeIndex`).
    /// `side` is "front" or "back".
    public static func renderCloze(_ text: String, activeIndex: Int, side: String) -> [Segment] {
        var segments: [Segment] = []
        var lastUTF16 = 0
        let ns = text as NSString
        for m in matches(in: text) {
            let start = m.range.location
            if start > lastUTF16 {
                segments.append(Segment(text: ns.substring(with: NSRange(location: lastUTF16, length: start - lastUTF16)),
                                        clozeIndex: nil, clozeActive: nil))
            }
            let indexStr = group(m, 1, in: text) ?? ""
            let index = Int(indexStr) ?? 0
            let answer = group(m, 2, in: text) ?? ""
            let hint = group(m, 3, in: text)
            if index < 1 {
                segments.append(Segment(text: ns.substring(with: m.range), clozeIndex: nil, clozeActive: nil))
            } else if index == activeIndex {
                let blank = side == "front" ? "[\(hint ?? "...")]" : answer
                segments.append(Segment(text: blank, clozeIndex: index, clozeActive: true))
            } else {
                segments.append(Segment(text: answer, clozeIndex: index, clozeActive: false))
            }
            lastUTF16 = m.range.location + m.range.length
        }
        if lastUTF16 < ns.length {
            segments.append(Segment(text: ns.substring(from: lastUTF16), clozeIndex: nil, clozeActive: nil))
        }
        return segments
    }

    /// Plain-text preview for one card.
    public static func clozeText(_ text: String, activeIndex: Int, side: String) -> String {
        renderCloze(text, activeIndex: activeIndex, side: side).map(\.text).joined()
    }
}
