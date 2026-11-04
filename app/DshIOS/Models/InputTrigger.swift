import Foundation

/// A `/` or `@` token being typed (input-trigger `detectTrigger`, C-97). The
/// caret is taken to be at the end of the draft: the phone composer has no
/// caret API on iOS 17, and new text is almost always typed there.
struct TriggerHit: Equatable {
    var trigger: Character
    /// Text after the trigger up to the caret (inside an open `@"…` quote for a quoted path).
    var query: String
    var quoted: Bool
    /// `leading`: the token opens the draft (a command chip may claim it).
    var leading: Bool
    /// Offset of the trigger character in the draft (Character count).
    var start: Int

    /// The trigger at the end of `draft`, if one is live there.
    static func detect(in draft: String) -> TriggerHit? {
        let chars = Array(draft)
        let firstNonSpace = chars.firstIndex { !$0.isWhitespace }
        // `@`: `(^|\s)@"…` (quotes may hold spaces) or `(^|\s)@\S*`; an `@` inside a word (mail) is not one.
        if let quote = draft.firstMatch(of: /(?:^|\s)(@"([^"]*))$/) {
            let start = chars.count - quote.output.1.count
            return TriggerHit(trigger: "@", query: String(quote.output.2), quoted: true, leading: firstNonSpace == start, start: start)
        }
        if let plain = draft.firstMatch(of: /(?:^|\s)(@(\S*))$/) {
            let start = chars.count - plain.output.1.count
            return TriggerHit(trigger: "@", query: String(plain.output.2), quoted: false, leading: firstNonSpace == start, start: start)
        }
        // `/`: scan left to the first whitespace; a slash failing the word boundary (URLs) is an ordinary character.
        var index = chars.count - 1
        while index >= 0 {
            let ch = chars[index]
            if ch.isWhitespace { return nil }
            if ch == "/", boundaryOK(chars, index) {
                return TriggerHit(trigger: "/", query: String(chars[(index + 1)...]), quoted: false, leading: firstNonSpace == index, start: index)
            }
            index -= 1
        }
        return nil
    }

    /// A trigger opens at the start, after whitespace or punctuation; never after a word
    /// character, a second `/` (`//`) or a scheme colon (`https:/`).
    private static func boundaryOK(_ chars: [Character], _ index: Int) -> Bool {
        if index == 0 { return true }
        let prev = chars[index - 1]
        if prev.isWhitespace { return true }
        if prev.isLetter || prev.isNumber || prev == "_" { return false }
        if prev == "/" { return false }
        if prev == ":", index >= 2, !chars[index - 2].isWhitespace { return false }
        return true
    }

    /// Replace the token (trigger to end of draft) with `replacement`.
    func replacing(in draft: String, with replacement: String) -> String {
        String(Array(draft).prefix(start)) + replacement
    }
}

/// Fuzzy ranking shared by the `/` menu and the model search (ui-primitives `rankByName`):
/// an ordered subsequence match, prefixes first, then the alignment score, then input order.
enum FuzzyRank {
    static func rank<T>(_ items: [T], query: String, names: (T) -> [String]) -> [T] {
        let needle = Array(query.lowercased())
        guard !needle.isEmpty else { return items }
        var scored: [(item: T, index: Int, prefix: Bool, score: Int)] = []
        for (index, item) in items.enumerated() {
            var prefix = false
            var best: Int?
            for name in names(item) {
                let haystack = name.lowercased()
                guard let value = score(Array(haystack), needle) else { continue }
                prefix = prefix || haystack.hasPrefix(String(needle))
                best = max(best ?? value, value)
            }
            if let best { scored.append((item, index, prefix, best)) }
        }
        scored.sort { a, b in
            if a.prefix != b.prefix { return a.prefix }
            if a.score != b.score { return a.score > b.score }
            return a.index < b.index
        }
        return scored.map(\.item)
    }

    /// The web's subsequence score: word starts (after `-`/`_`) earn a bonus, gaps cost.
    static func score(_ text: [Character], _ query: [Character]) -> Int? {
        guard query.count <= text.count, let first = query.first else { return nil }
        let none = Int.min / 4
        func bonus(_ i: Int) -> Int { i == 0 || text[i - 1] == "-" || text[i - 1] == "_" ? 8 : 0 }
        var row = [Int](repeating: none, count: text.count)
        for s in text.indices where text[s] == first { row[s] = 1 + bonus(s) - s }
        for q in query.indices.dropFirst() {
            var next = [Int](repeating: none, count: text.count)
            var previous = none, beforePrevious = none, gap = none
            for (g, value) in row.enumerated() {
                if beforePrevious != none { gap = max(gap, beforePrevious + g - 2) }
                if text[g] == query[q] {
                    let base = 1 + bonus(g)
                    var best = none
                    if previous != none { best = previous + base + 4 }
                    if gap != none { best = max(best, gap + base + 1 - g) }
                    next[g] = best
                }
                beforePrevious = previous
                previous = value
            }
            row = next
        }
        let best = row.max() ?? none
        return best == none ? nil : best
    }
}

/// `@path` as prompt text (file-reference `formatFileMention`): whitespace uses
/// `@"path"`, a quoted directory keeps its quote open so completion can descend.
/// Paths with control characters or quotes cannot be written and return nil.
func formatFileMention(path: String, directory: Bool, preserveQuote: Bool) -> String? {
    let value = directory ? path + "/" : path
    if value.unicodeScalars.contains(where: { $0.value < 0x20 || (0x7f...0x9f).contains($0.value) || $0 == "\"" }) { return nil }
    if !preserveQuote && !value.contains(where: \.isWhitespace) { return "@" + value }
    return directory ? "@\"\(value)" : "@\"\(value)\""
}

/// A session reference as the engine reads it, `@[标题](dsh-session:…)`; people read `@标题`.
enum SessionMention {
    private static let pattern = /@\[([^\]]*)\]\(dsh-session:[^)]*\)/

    static func plain(_ text: String) -> String {
        text.replacing(pattern) { "@\($0.1)" }
    }
}
