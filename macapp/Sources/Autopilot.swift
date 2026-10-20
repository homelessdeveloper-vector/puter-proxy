import Foundation

// MARK: - Discovery result

struct Discovery {
    var accounts: [Account] = []
    var notes: [String] = []
    var warnings: [String] = []
}

// MARK: - Autopilot

/// Makes the app work without a manual tour: finds credentials that already
/// exist on the machine, proves each one actually works, drops the dead ones,
/// and keeps Tor alive.
///
/// Deliberately absent: creating new Puter accounts. Minting identities
/// programmatically to work around per-account limits is circumvention, not
/// configuration, so the pool is limited to credentials the operator supplies.
enum Autopilot {

    // MARK: Candidate sources

    /// Locations people actually keep a Puter token. Ordered by specificity so
    /// an explicit file wins over an inherited environment variable.
    static var tokenFiles: [URL] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return [
            home.appendingPathComponent(".puter-token"),
            home.appendingPathComponent(".config/puter/token"),
            home.appendingPathComponent(".config/puter-proxy/token"),
            AppPaths.support.appendingPathComponent(".puter-token"),
        ]
    }

    /// Read a token from a file, tolerating the shapes people paste: bare token,
    /// `token=…`, `PUTER_AUTH_TOKEN=…`, or JSON with a token field.
    static func readToken(from url: URL) -> String? {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return nil }

        // JSON manifest?
        if raw.hasPrefix("{") || raw.hasPrefix("[") {
            if let data = raw.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) {
                if let d = obj as? [String: Any] {
                    for key in ["token", "PUTER_AUTH_TOKEN", "authToken", "auth_token"] {
                        if let t = d[key] as? String, !t.isEmpty { return Keys.normalizeToken(t) }
                    }
                    if let list = d["accounts"] as? [[String: Any]] {
                        for a in list {
                            if let t = a["token"] as? String, !t.isEmpty {
                                return Keys.normalizeToken(t)
                            }
                        }
                    }
                }
                if let arr = obj as? [[String: Any]],
                   let t = arr.first?["token"] as? String, !t.isEmpty {
                    return Keys.normalizeToken(t)
                }
            }
            return nil
        }

        // key=value form.
        for line in raw.split(separator: "\n") {
            let l = line.trimmingCharacters(in: .whitespaces)
            if l.hasPrefix("#") { continue }
            if let eq = l.firstIndex(of: "=") {
                let key = l[..<eq].trimmingCharacters(in: .whitespaces).uppercased()
                if key == "PUTER_AUTH_TOKEN" || key == "TOKEN" || key == "PUTER_TOKEN" {
                    return Keys.normalizeToken(String(l[l.index(after: eq)...]))
                }
            }
        }

        // Bare token, possibly quoted.
        return Keys.normalizeToken(raw)
    }

    /// Collect every distinct token we can legitimately find, then explain where
    /// each came from so the UI is not doing magic the user cannot audit.
    static func discover(seed: [Account] = []) -> Discovery {
        var out = Discovery()
        var seen = Set<String>()

        func add(_ token: String, label: String, source: String) {
            let t = Keys.normalizeToken(token)
            guard !t.isEmpty else { return }
            guard !seen.contains(t) else {
                out.notes.append("Skipped duplicate token from \(source)")
                return
            }
            seen.insert(t)
            var id = label.lowercased().replacingOccurrences(of: " ", with: "-")
            if out.accounts.contains(where: { $0.id == id }) { id += "-\(seen.count)" }
            out.accounts.append(Account(id: id, label: label, token: t, proxy: nil))
            out.notes.append("Found \(label) from \(source)")
        }

        // 1. Already-configured accounts win: they carry user intent.
        for a in seed { add(a.token, label: a.label, source: "existing configuration") }

        // 2. Environment. Present when launched from a shell that exported it.
        if let env = ProcessInfo.processInfo.environment["PUTER_AUTH_TOKEN"], !env.isEmpty {
            add(env, label: "env-token", source: "PUTER_AUTH_TOKEN")
        }

        // 3. Token files.
        for url in tokenFiles {
            if let t = readToken(from: url) {
                add(t, label: url.deletingPathExtension().lastPathComponent,
                    source: url.path)
            }
        }

        // 4. The proxy's own accounts.json, if a previous install left one.
        if let data = try? Data(contentsOf: AppPaths.accounts),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let list = obj["accounts"] as? [[String: Any]] {
            for a in list {
                if let t = a["token"] as? String {
                    add(t, label: (a["label"] as? String) ?? "previous-install",
                        source: "accounts.json")
                }
            }
        }

        if out.accounts.isEmpty {
            out.warnings.append(
                "No Puter token found. Add one in the app, or set PUTER_AUTH_TOKEN.")
        }
        return out
    }

    // MARK: Verification

    /// Ask Puter who this token belongs to. Returns the username on success, or
    /// nil with a reason on failure.
    ///
    /// Uses `/whoami` directly rather than the SDK: this runs before the server
    /// starts, and a single HTTP call is far cheaper than bootstrapping a VM
    /// context per account.
    static func verify(token: String, proxy: String?) -> (ok: Bool, detail: String) {
        guard let url = URL(string: "https://api.puter.com/whoami") else {
            return (false, "bad url")
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = proxy == nil ? 12 : 40
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        // Verification must honour the same egress as the server, or a token
        // that only works directly would be reported healthy and then fail.
        let sem = DispatchSemaphore(value: 0)
        var result: (Bool, String) = (false, "no response")

        if let proxy, !proxy.isEmpty {
            // SOCKS needs the server's dispatcher path; defer to the node
            // helper rather than duplicating proxy plumbing in Swift.
            result = verifyViaNode(token: token, proxy: proxy)
            return result
        }

        URLSession.shared.dataTask(with: req) { data, resp, err in
            defer { sem.signal() }
            if let err {
                result = (false, err.localizedDescription)
                return
            }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 200, let data,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let name = (obj["username"] as? String) ?? "account"
                result = (true, name)
            } else if code == 401 || code == 403 {
                result = (false, "token rejected (\(code))")
            } else {
                result = (false, "HTTP \(code)")
            }
        }.resume()
        _ = sem.wait(timeout: .now() + 15)
        return result
    }

    /// Route verification through the bundled Node runtime so SOCKS5 works
    /// identically to the server's own transport.
    static func verifyViaNode(token: String, proxy: String) -> (Bool, String) {
        guard let node = Supervisor.bundledNode() else {
            return (false, "no node runtime for proxied check")
        }
        let script = """
        const {ProxyAgent, fetch} = require('undici');
        const agent = new ProxyAgent('\(proxy.replacingOccurrences(of: "socks5h://", with: "socks5://"))');
        (async () => {
          try {
            const r = await fetch('https://api.puter.com/whoami', {
              dispatcher: agent,
              headers: {Authorization: 'Bearer \(token)'},
              signal: AbortSignal.timeout(35000),
            });
            const body = await r.text();
            if (r.status === 200) {
              try { const j = JSON.parse(body); process.stdout.write('OK ' + (j.username||'account')); }
              catch { process.stdout.write('OK account'); }
            } else {
              process.stdout.write('FAIL token rejected (' + r.status + ')');
            }
          } catch (e) {
            process.stdout.write('FAIL ' + (e.cause?.code || e.message));
          } finally { await agent.close().catch(()=>{}); }
        })();
        """

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)
        proc.arguments = ["-e", script]
        // undici lives in the bundled server's node_modules, not in a global
        // location, so point NODE_PATH at it.
        var env = ProcessInfo.processInfo.environment
        env["NODE_PATH"] = AppPaths.serverRoot
            .appendingPathComponent("node_modules").path
        proc.environment = env

        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()

        do {
            try proc.run()
        } catch {
            return (false, "could not run node")
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        let out = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        if out.hasPrefix("OK ") {
            return (true, String(out.dropFirst(3)))
        }
        if out.hasPrefix("FAIL ") {
            return (false, String(out.dropFirst(5)))
        }
        return (false, out.isEmpty ? "no output" : out)
    }

    // MARK: Pool hygiene

    /// Verify every account, keep the working ones, and report the rest.
    /// This is what makes first launch feel automatic: a stale token from six
    /// months ago is dropped with a reason instead of causing mysterious 401s.
    static func prune(_ accounts: [Account], proxy: String?,
                      progress: ((String) -> Void)? = nil) -> (kept: [Account], dropped: [String]) {
        var kept: [Account] = []
        var dropped: [String] = []

        for (i, acct) in accounts.enumerated() {
            progress?("Checking \(acct.label) (\(i + 1)/\(accounts.count))…")
            let (ok, detail) = verify(token: acct.token, proxy: proxy)
            if ok {
                var a = acct
                // Adopt the real username as the label only when the user has
                // not chosen one; overwriting a deliberate name is rude.
                if a.label.hasPrefix("account-") || a.label == "primary"
                    || a.label == "env-token" {
                    a.label = detail
                }
                kept.append(a)
                progress?("  \(a.label): OK")
            } else {
                dropped.append("\(acct.label): \(detail)")
                progress?("  \(acct.label): dropped (\(detail))")
            }
        }
        return (kept, dropped)
    }

    // MARK: Tor watchdog

    /// Restart Tor if it dies. A dead daemon otherwise presents as every request
    /// failing at once, which looks like a Puter outage rather than a local one.
    static func ensureTor(supervisor: Supervisor, attempt: Int = 0) {
        guard attempt < 3 else {
            supervisor.log.append("[autopilot] Tor did not come up after 3 attempts; running direct")
            return
        }
        guard !Net.portOpen(9050) else { return }

        supervisor.log.append("[autopilot] Tor is not listening; starting it (attempt \(attempt + 1))")
        supervisor.startTor()

        DispatchQueue.global().asyncAfter(deadline: .now() + 20) {
            if Net.portOpen(9050) {
                supervisor.log.append("[autopilot] Tor is up")
            } else {
                supervisor.log.append("[autopilot] Tor still down; retrying")
                ensureTor(supervisor: supervisor, attempt: attempt + 1)
            }
        }
    }
}
