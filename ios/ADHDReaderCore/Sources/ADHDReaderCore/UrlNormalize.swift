import Foundation

/// Canonical article identity, ported from `src/shared/urlNormalize.ts`:
/// matches feed-item links against page URLs even when they differ by scheme,
/// www, hash, tracking params, or trailing slash. Scheme is dropped so http and
/// https collapse to one key.
public enum UrlNormalize {
    static let trackingParam = try! NSRegularExpression(
        pattern: #"^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ref|ref_src|source|cmpid|s_kwcid|igshid)$"#,
        options: [.caseInsensitive])

    private static func isTracking(_ key: String) -> Bool {
        let r = NSRange(key.startIndex..., in: key)
        return trackingParam.firstMatch(in: key, range: r) != nil
    }

    /// encodeURIComponent-equivalent character set.
    static let componentAllowed: CharacterSet = {
        var set = CharacterSet.alphanumerics
        set.insert(charactersIn: "-_.!~*'()")
        return set
    }()

    public static func normalize(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let comps = URLComponents(string: trimmed), let scheme = comps.scheme?.lowercased() else {
            return trimmed.lowercased()
        }
        guard scheme == "http" || scheme == "https", let rawHost = comps.host else {
            return trimmed
        }

        var host = rawHost.lowercased()
        if host.hasPrefix("www.") { host = String(host.dropFirst(4)) }

        let items = (comps.queryItems ?? [])
            .filter { !isTracking($0.name) }
            .sorted { $0.name < $1.name }
        let query: String
        if items.isEmpty {
            query = ""
        } else {
            query = "?" + items.map { item in
                let k = item.name.addingPercentEncoding(withAllowedCharacters: componentAllowed) ?? item.name
                let v = (item.value ?? "").addingPercentEncoding(withAllowedCharacters: componentAllowed) ?? ""
                return "\(k)=\(v)"
            }.joined(separator: "&")
        }

        var path = comps.percentEncodedPath
        while path.hasSuffix("/") { path = String(path.dropLast()) }
        if path.isEmpty { path = "/" }

        return "\(host)\(path)\(query)"
    }

    /// Feed-item id — `base64(encodeURIComponent(link+title))[0..<32]`, matching
    /// the extension's `generateItemId`.
    public static func itemId(link: String, title: String) -> String {
        let joined = link + title
        let encoded = joined.addingPercentEncoding(withAllowedCharacters: componentAllowed) ?? joined
        let b64 = Data(encoded.utf8).base64EncodedString()
        return String(b64.prefix(32))
    }

    /// Firestore-safe document id for a reading-progress record: base64url of the
    /// normalized URL (no '/' so it's a valid doc id; deterministic + reversible).
    public static func progressDocId(_ url: String) -> String {
        let norm = normalize(url)
        return Data(norm.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
