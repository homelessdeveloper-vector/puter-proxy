import Foundation
import CryptoKit

// MARK: - Paths

/// Every mutable file lives under Application Support so the bundle stays
/// read-only and the app works when launched from /Applications (where the
/// bundle itself is not writable by the user).
enum AppPaths {
    static let support: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("PuterProxy", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    static var env: URL { support.appendingPathComponent(".env") }
    static var accounts: URL { support.appendingPathComponent("accounts.json") }
    static var logs: URL {
        let d = support.appendingPathComponent("logs", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    static var serverLog: URL { logs.appendingPathComponent("server.log") }
    static var torDir: URL {
        let d = support.appendingPathComponent("tor", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    static var torLog: URL { torDir.appendingPathComponent("tor.log") }
    static var prefs: URL { support.appendingPathComponent("prefs.json") }

    /// The shim that ties the server's lifetime to the app's. Lives next to the
    /// executable so it always travels with the bundle.
    static var launcherScript: String? {
        let sibling = Bundle.main.bundleURL
            .appendingPathComponent("Contents/MacOS/launcher.js").path
        if FileManager.default.fileExists(atPath: sibling) { return sibling }
        let resources = Bundle.main.resourceURL?
            .appendingPathComponent("launcher.js").path
        if let resources, FileManager.default.fileExists(atPath: resources) {
            return resources
        }
        return nil
    }

    /// A support-directory copy lets a user override the shipped server (for
    /// example to patch a dependency) without rebuilding the bundle. Without
    /// one, fall back to the copy inside `Contents/Resources/server`.
    static var serverRoot: URL {
        let override = support.appendingPathComponent("server", isDirectory: true)
        if FileManager.default.fileExists(
            atPath: override.appendingPathComponent("src/index.js").path
        ) {
            return override
        }
        if let bundled = Bundle.main.resourceURL?
            .appendingPathComponent("server", isDirectory: true),
           FileManager.default.fileExists(
               atPath: bundled.appendingPathComponent("src/index.js").path
           ) {
            return bundled
        }
        return override
    }
}

// MARK: - Accounts

struct Account: Codable, Identifiable, Hashable {
    var id: String
    var label: String
    var token: String
    var proxy: String?      // nil = inherit global, "" = explicit direct
}

enum ProxyMode: String, Codable, CaseIterable {
    case none, tor

    var envValue: String { self == .tor ? "tor" : "" }
    var display: String { self == .tor ? "Tor (SOCKS5)" : "Direct" }
}

// MARK: - Preferences

struct Prefs: Codable {
    var proxyMode: ProxyMode = .tor
    var port: Int = 8080
    var defaultModel: String = "gpt-4o-mini"
    var accounts: [Account] = []
    var clientKey: String = ""     // plaintext, shown in the UI
    var adminKey: String = ""
    var setupComplete: Bool = false

    static func load() -> Prefs {
        guard let data = try? Data(contentsOf: AppPaths.prefs),
              let p = try? JSONDecoder().decode(Prefs.self, from: data) else {
            return Prefs()
        }
        return p
    }

    func save() {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? enc.encode(self) {
            try? data.write(to: AppPaths.prefs, options: .atomic)
            // Contains live tokens and API keys.
            try? FileManager.default.setAttributes([.posixPermissions: 0o600],
                                                   ofItemAtPath: AppPaths.prefs.path)
        }
    }
}

// MARK: - Key generation

enum Keys {
    static func randomHex(_ bytes: Int = 32) -> String {
        var buf = [UInt8](repeating: 0, count: bytes)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes, &buf)
        return buf.map { String(format: "%02x", $0) }.joined()
    }

    static func sha256Hex(_ s: String) -> String {
        let digest = SHA256.hash(data: Data(s.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    static func normalizeToken(_ raw: String) -> String {
        var t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.lowercased().hasPrefix("bearer ") {
            t = String(t.dropFirst(7)).trimmingCharacters(in: .whitespaces)
        }
        // Tolerate quotes pasted from a shell or a dashboard.
        if t.count >= 2, (t.hasPrefix("\"") && t.hasSuffix("\"")) ||
            (t.hasPrefix("'") && t.hasSuffix("'")) {
            t = String(t.dropFirst().dropLast())
        }
        return t
    }

    /// A JWT-shaped Puter token. We do not verify the signature — that is the
    /// server's job — but catching an obvious paste error here saves a
    /// fifteen-second round trip and a confusing 401.
    static func looksLikePuterToken(_ t: String) -> Bool {
        let parts = t.split(separator: ".")
        return parts.count == 3 && t.count > 40
    }

    static func tokenFingerprint(_ t: String) -> String {
        String(sha256Hex(t).prefix(12))
    }
}

// MARK: - Config writer

enum ConfigWriter {
    /// Writes .env and accounts.json from prefs. Returns a list of warnings for
    /// values we accept but that will not work.
    @discardableResult
    static func write(_ prefs: Prefs) -> [String] {
        var warnings: [String] = []

        let clientHash = Keys.sha256Hex(prefs.clientKey)
        let adminHash = Keys.sha256Hex(prefs.adminKey)

        // A comma separates key entries, so scopes use "+".
        let keysLine = "client:sha256:\(clientHash)|execute,admin:sha256:\(adminHash)|execute+admin"

        var lines: [String] = [
            "# Generated by Puter Proxy.app — edits here are overwritten by the app.",
            "# Source of truth: \(AppPaths.prefs.path)",
            "",
            "NODE_ENV=production",
            "HOST=127.0.0.1",
            "PORT=\(prefs.port)",
            "TRUST_PROXY=0",
            "",
            "API_KEYS=\(keysLine)",
            "",
        ]

        // First account also seeds PUTER_AUTH_TOKEN so the server has a
        // credential even if the manifest is unreadable.
        if let first = prefs.accounts.first {
            lines.append("PUTER_AUTH_TOKEN=\(yamlSafe(first.token))")
        } else {
            lines.append("PUTER_AUTH_TOKEN=")
            warnings.append("No Puter token configured; the server will refuse to start.")
        }

        lines += [
            "ACCOUNTS_FILE=\(AppPaths.accounts.path)",
            "PUTER_ACCOUNTS=",
            "ACCOUNT_MANIFEST_REPO=",
            "ACCOUNT_MANIFEST_TOKEN=",
            "",
            "ACCOUNT_MAX_ATTEMPTS=2",
            "ACCOUNT_FAILOVER_ON_429=0",
            "",
            "PUTER_PROXY=\(prefs.proxyMode.envValue)",
            "",
            "PUTER_API_ORIGIN=",
            "PUTER_NORMALIZE=1",
            "PUTER_DEFAULT_MODEL=\(prefs.defaultModel)",
            "PUTER_MAX_TOKENS_CAP=8192",
            "",
            "BODY_LIMIT=1mb",
            "REQUEST_TIMEOUT_MS=120000",
            "RATE_LIMIT_PER_MINUTE=60",
            "RATE_LIMIT_BURST=10",
            "",
            "CORS_ORIGINS=",
            "LOG_LEVEL=info",
            "",
        ]

        let envText = lines.joined(separator: "\n")
        do {
            try envText.write(to: AppPaths.env, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o600],
                                                   ofItemAtPath: AppPaths.env.path)
        } catch {
            warnings.append("Could not write config: \(error.localizedDescription)")
        }

        // accounts.json — the pool the server actually rotates over.
        let payload: [String: Any] = [
            "accounts": prefs.accounts.map { a -> [String: Any] in
                var d: [String: Any] = ["id": a.id, "label": a.label, "token": a.token]
                if let p = a.proxy, p != "inherit" { d["proxy"] = p.isEmpty ? NSNull() : p }
                return d
            },
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload,
                                                  options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: AppPaths.accounts, options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600],
                                                   ofItemAtPath: AppPaths.accounts.path)
        }

        for a in prefs.accounts where !Keys.looksLikePuterToken(a.token) {
            warnings.append("\"\(a.label)\" does not look like a Puter token (expected three dot-separated parts).")
        }

        return warnings
    }

    /// .env has no quoting rules we can rely on, so strip characters that would
    /// break line-based parsing rather than trying to escape them.
    private static func yamlSafe(_ s: String) -> String {
        s.replacingOccurrences(of: "\n", with: "")
            .replacingOccurrences(of: "\r", with: "")
            .trimmingCharacters(in: .whitespaces)
    }
}
