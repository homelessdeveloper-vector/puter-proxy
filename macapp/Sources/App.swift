import AppKit
import WebKit

// MARK: - Model catalogue

/// Curated shortlist shown in the UI. Puter accepts more models than this —
/// the list exists so the picker is useful rather than a wall of names, and
/// "custom" entries survive a round trip.
enum Catalogue {
    struct Model {
        let id: String
        let group: String
        let free: Bool
    }

    static let models: [Model] = [
        .init(id: "gpt-4o-mini",     group: "OpenAI",    free: true),
        .init(id: "gpt-4o",          group: "OpenAI",    free: false),
        .init(id: "gpt-4.1",         group: "OpenAI",    free: false),
        .init(id: "gpt-4.1-mini",    group: "OpenAI",    free: true),
        .init(id: "o3-mini",         group: "OpenAI",    free: false),
        .init(id: "claude-sonnet-4", group: "Anthropic", free: false),
        .init(id: "claude-3-5-sonnet", group: "Anthropic", free: false),
        .init(id: "claude-3-haiku",  group: "Anthropic", free: true),
        .init(id: "gemini-2.0-flash", group: "Google",   free: true),
        .init(id: "gemini-1.5-pro",  group: "Google",    free: false),
        .init(id: "deepseek-chat",   group: "DeepSeek",  free: true),
        .init(id: "deepseek-reasoner", group: "DeepSeek", free: false),
        .init(id: "mistral-large-latest", group: "Mistral", free: false),
        .init(id: "llama-3.3-70b",   group: "Meta",      free: true),
    ]

    static func json() -> [[String: Any]] {
        models.map { ["id": $0.id, "group": $0.group, "free": $0.free] }
    }
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, NSWindowDelegate {

    var window: NSWindow!
    var webView: WKWebView!
    var supervisor: Supervisor!
    var prefs = Prefs.load()
    private var readiness: DispatchWorkItem?
    /// Retained while Puter's sign-in window is open.
    private var signInWindow: SignInWindow?

    // MARK: Lifecycle

    func applicationDidFinishLaunching(_ n: Notification) {
        supervisor = Supervisor(port: UInt16(prefs.port))

        // A bundle launched from /Applications gets SIGTERM on logout or
        // `kill`, not an AppKit quit. Without these, the children outlive us.
        signal(SIGTERM) { _ in
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
        }
        signal(SIGINT) { _ in
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
        }

        buildWindow()

        // First run: try to come up without asking anything. Only fall back to
        // the wizard when there is genuinely nothing to work with.
        if prefs.setupComplete {
            supervise()
        } else {
            autoStart()
        }
    }

    /// Closing the window quits the app: it is a single-window utility, and a
    /// background helper with no visible window is confusing.
    func windowWillClose(_ n: Notification) {
        NSApplication.shared.terminate(nil)
    }

    /// Discover, verify, then start — the "works out of the box" path.
    ///
    /// Runs the network checks off the main thread so the window stays
    /// responsive, and reports progress into the log where the user can see it.
    func autoStart() {
        if prefs.clientKey.isEmpty { prefs.clientKey = Keys.randomHex() }
        if prefs.adminKey.isEmpty { prefs.adminKey = Keys.randomHex() }
        prefs.save()

        supervisor.log.append("[autopilot] looking for existing credentials")

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let d = Autopilot.discover(seed: self.prefs.accounts)
            for n in d.notes { self.supervisor.log.append("[autopilot] \(n)") }

            guard !d.accounts.isEmpty else {
                DispatchQueue.main.async {
                    for w in d.warnings { self.supervisor.log.append("[autopilot] \(w)") }
                    // Nothing found: the wizard is now the only way forward.
                    self.presentWizard()
                }
                return
            }

            // Verify against the real service before committing to the pool.
            let proxy = self.prefs.proxyMode == .tor
                ? "socks5h://127.0.0.1:9050" : nil
            if self.prefs.proxyMode == .tor {
                self.supervisor.log.append("[autopilot] starting Tor for verification")
                self.supervisor.startTor()
                _ = self.supervisor.waitFor(9050, timeout: 45)
            }

            let (kept, dropped) = Autopilot.prune(d.accounts, proxy: proxy) { msg in
                self.supervisor.log.append("[autopilot] \(msg)")
            }
            for x in dropped {
                self.supervisor.log.append("[autopilot] dropped \(x)")
            }

            DispatchQueue.main.async {
                if kept.isEmpty {
                    // Every discovered token was rejected. Do not silently start
                    // a server that cannot serve anything.
                    self.supervisor.log.append(
                        "[autopilot] no working credentials; opening setup")
                    self.presentWizard()
                    return
                }
                self.prefs.accounts = kept
                self.prefs.setupComplete = true
                self.prefs.save()
                ConfigWriter.write(self.prefs)
                self.supervisor.log.append("[autopilot] ready with \(kept.count) account(s)")
                self.supervise()
                self.reloadUI()
            }
        }
    }

    func buildWindow() {
        let frame = NSRect(x: 0, y: 0, width: 880, height: 760)
        window = NSWindow(contentRect: frame,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Puter Proxy"
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(calibratedWhite: 0.96, alpha: 1)
        window.delegate = self
        window.center()

        let cfg = WKWebViewConfiguration()
        // Only our own bridge; no remote content is ever loaded.
        cfg.userContentController.add(self, name: "app")
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true

        webView = WKWebView(frame: frame, configuration: cfg)
        webView.setValue(false, forKey: "drawsBackground")
        webView.autoresizingMask = [.width, .height]

        if let url = Bundle.main.url(forResource: "index", withExtension: "html") {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            webView.loadHTMLString("<h1 style='font-family:-apple-system'>index.html missing</h1>",
                                   baseURL: nil)
        }

        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Start whatever the user asked for, then wait until it is genuinely ready
    /// before reporting success.
    func supervise() {
        if prefs.proxyMode == .tor {
            supervisor.startTor()
        }
        supervisor.startServer(prefs: prefs)
        waitForServer()
    }

    func waitForServer() {
        readiness?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            // Poll the loopback port rather than sleeping a fixed time; the
            // server is ready exactly when it accepts connections.
            var tries = 0
            while tries < 120 {
                if Net.portOpen(UInt16(self.prefs.port)) {
                    self.supervisor.objectWillChange.send()
                    return
                }
                usleep(250_000)
                tries += 1
            }
        }
        readiness = work
        DispatchQueue.global(qos: .userInitiated).async(execute: work)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

    /// Killing Node without letting it close its sockets leaves the port bound
    /// briefly; stop children explicitly so a relaunch is clean.
    func applicationWillTerminate(_ n: Notification) {
        readiness?.cancel()
        let sem = DispatchSemaphore(value: 0)
        supervisor.stopAll { sem.signal() }
        _ = sem.wait(timeout: .now() + 8)
        // Belt and braces: anything still alive after the grace period goes now.
        supervisor.stopAllSynchronously()
    }

    // MARK: Wizard

    func presentWizard() {
        let alert = NSAlert()
        alert.messageText = "Welcome to Puter Proxy"
        alert.informativeText = """
        This app runs a local API gateway in front of Puter's cloud models.

        Setup will:
          • create your client and admin API keys
          • store them in Application Support (mode 0600)
          • start Tor if you choose the Tor route
          • launch the bundled server on 127.0.0.1:8080

        Nothing leaves your machine except the model requests themselves.
        """
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Quit")
        alert.alertStyle = .informational

        if alert.runModal() != .alertFirstButtonReturn {
            NSApp.terminate(nil)
            return
        }

        // Generate keys immediately so the user always has working credentials,
        // even if they abandon the rest of setup.
        if prefs.clientKey.isEmpty { prefs.clientKey = Keys.randomHex() }
        if prefs.adminKey.isEmpty { prefs.adminKey = Keys.randomHex() }

        promptForToken()
    }

    func promptForToken() {
        let alert = NSAlert()
        alert.messageText = "Add a Puter account"
        alert.informativeText = """
        Paste your Puter auth token. You can add more accounts later.

        You can skip this and add accounts from the main window instead.
        """
        alert.addButton(withTitle: "Save & Start")
        alert.addButton(withTitle: "Skip")

        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 380, height: 24))
        field.placeholderString = "eyJhbGciOi… (three dot-separated parts)"
        alert.accessoryView = field
        alert.window.initialFirstResponder = field

        let resp = alert.runModal()
        if resp == .alertFirstButtonReturn, !field.stringValue.isEmpty {
            let token = Keys.normalizeToken(field.stringValue)
            if Keys.looksLikePuterToken(token) {
                prefs.accounts = [Account(id: "primary", label: "primary",
                                          token: token, proxy: nil)]
            } else {
                // Still accepted — the wizard should not be the arbiter of
                // token validity — but say so rather than failing silently.
                prefs.accounts = [Account(id: "primary", label: "primary",
                                          token: token, proxy: nil)]
                let warn = NSAlert()
                warn.messageText = "That token looks unusual"
                warn.informativeText = "It saved fine, but Puter tokens normally "
                    + "have three dot-separated parts. If requests fail with 401, "
                    + "check the token."
                warn.addButton(withTitle: "OK")
                warn.runModal()
            }
        }

        chooseEgress()
    }

    func chooseEgress() {
        let alert = NSAlert()
        alert.messageText = "How should traffic leave this machine?"
        alert.informativeText = """
        Tor routes every request through an anonymising relay. Expect roughly \
        2–3 seconds of added latency, and note that some providers block exit \
        nodes.

        Direct is faster and more reliable. You can change this at any time.
        """
        alert.addButton(withTitle: "Use Tor")
        alert.addButton(withTitle: "Direct connection")

        prefs.proxyMode = alert.runModal() == .alertFirstButtonReturn ? .tor : .none
        finishSetup()
    }

    func finishSetup() {
        prefs.setupComplete = true
        prefs.save()

        let warnings = ConfigWriter.write(prefs)
        for w in warnings { supervisor.log.append("[config] \(w)") }

        if !warnings.isEmpty {
            let a = NSAlert()
            a.messageText = "Setup finished with warnings"
            a.informativeText = warnings.joined(separator: "\n")
            a.addButton(withTitle: "Continue")
            a.alertStyle = .warning
            a.runModal()
        }

        supervise()
        reloadUI()
    }

    func reloadUI() {
        webView.evaluateJavaScript("state = await native('state'); render();")
    }

    // MARK: Bridge

    func userContentController(_ uc: WKUserContentController,
                              didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let id = body["id"] as? Int,
              let method = body["method"] as? String else { return }
        let args = body["args"] as? [String: Any] ?? [:]

        // Every reply is funnelled through one responder so the JS side has a
        // single, predictable continuation.
        let reply: (Any?) -> Void = { payload in
            let ok = !(payload is NSError)
            let value: Any = (payload as? NSError)?.localizedDescription
                ?? payload ?? NSNull()
            DispatchQueue.main.async {
                let js = "window.__resolve(\(id), \(ok), \(Self.jsLiteral(value)));"
                self.webView.evaluateJavaScript(js, completionHandler: nil)
            }
        }

        switch method {
        case "state":
            reply(statePayload())
        case "poll":
            reply(pollPayload())
        case "savePrefs":
            // The JS side sends the prefs object as the args payload itself.
            applyPrefs(args)
            reply(nil)
        case "addAccount":
            reply(addAccount(args))
        case "signIn":
            // Asynchronous: the answer arrives from the sign-in window later.
            beginSignIn(reply: reply)
        case "removeAccount":
            reply(removeAccount(args))
        case "copy":
            if let t = args["text"] as? String {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(t, forType: .string)
            }
            reply(nil)
        case "action":
            reply(perform(args["what"] as? String ?? ""))
        default:
            reply(NSError(domain: "app", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Unknown method \(method)"]))
        }
    }

    private static func jsLiteral(_ v: Any) -> String {
        guard JSONSerialization.isValidJSONObject(v),
              let d = try? JSONSerialization.data(withJSONObject: v),
              let s = String(data: d, encoding: .utf8) else {
            if let s = v as? String {
                let escaped = s
                    .replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "\"", with: "\\\"")
                    .replacingOccurrences(of: "\n", with: "\\n")
                return "\"\(escaped)\""
            }
            return "null"
        }
        return s
    }

    // MARK: Payloads

    func statePayload() -> [String: Any] {
        Prefs.load().pipe { p in
            [
                "prefs": [
                    "port": p.port,
                    "clientKey": p.clientKey,
                    "adminKey": p.adminKey,
                    "proxyMode": p.proxyMode.rawValue,
                    "defaultModel": p.defaultModel,
                    "models": Catalogue.json(),
                    "accounts": p.accounts.map { a -> [String: Any] in
                        [
                            "id": a.id,
                            "label": a.label,
                            "fingerprint": Keys.tokenFingerprint(a.token),
                        ]
                    },
                ],
                "paths": [
                    "Config:   \(AppPaths.env.path)",
                    "Accounts: \(AppPaths.accounts.path)",
                    "Logs:     \(AppPaths.serverLog.path)",
                    "Tor data: \(AppPaths.torDir.path)",
                ],
            ]
        }
    }

    func pollPayload() -> [String: Any] {
        var tor = "stopped"
        if supervisor.torRunning { tor = supervisor.torBootstrapped ? "running" : "bootstrapping" }

        var server = "stopped"
        if supervisor.serverRunning { server = "running" }
        else if supervisor.serverProcStarting { server = "starting" }

        return [
            "server": server,
            "tor": tor,
            "log": Array(supervisor.log.snapshot().suffix(250)),
            "health": healthMap(),
        ]
    }

    /// Ask the server itself which accounts are usable. Falls back to empty so a
    /// stopped server does not paint every account red.
    func healthMap() -> [String: String] {
        guard supervisor.serverRunning else { return [:] }
        let url = URL(string: "http://127.0.0.1:\(prefs.port)/v1/accounts")!
        var req = URLRequest(url: url)
        req.timeoutInterval = 2
        // The server authenticates with the plaintext key. Hashing here was a
        // leftover from an earlier design and made every account look dead.
        req.setValue(prefs.adminKey, forHTTPHeaderField: "X-API-Key")

        var out: [String: String] = [:]
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { data, _, _ in
            defer { sem.signal() }
            guard let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let accts = obj["accounts"] as? [[String: Any]] else { return }
            for a in accts {
                let id = a["id"] as? String ?? ""
                let state = a["state"] as? String ?? ""
                out[id] = (state == "ready" || state == "active") ? "ok" : "bad"
            }
        }.resume()
        _ = sem.wait(timeout: .now() + 3)
        return out
    }

    // MARK: Mutations

    func applyPrefs(_ d: [String: Any]) {
        if let v = d["proxyMode"] as? String, let m = ProxyMode(rawValue: v) {
            prefs.proxyMode = m
        }
        if let v = d["defaultModel"] as? String, !v.isEmpty {
            prefs.defaultModel = v
        }
        prefs.save()
    }

    /// Opens Puter's own sign-in page and adopts whatever token comes back.
    /// Account creation happens on Puter's side; this only performs the handoff.
    func beginSignIn(reply: @escaping (Any?) -> Void) {
        // Only one at a time: two windows would race to write the pool.
        guard signInWindow == nil else {
            reply(NSError(domain: "app", code: 9,
                          userInfo: [NSLocalizedDescriptionKey: "A sign-in window is already open."]))
            return
        }
        let w = SignInWindow()
        signInWindow = w

        w.present { [weak self] token, error in
            guard let self else { return }
            self.signInWindow = nil

            guard let token, !token.isEmpty else {
                reply(NSError(domain: "app", code: 10,
                              userInfo: [NSLocalizedDescriptionKey: error ?? "Sign-in did not complete."]))
                return
            }
            // Reuse the normal add path so dedupe and labelling behave the same
            // whether the token came from a paste or from Puter.
            let result = self.addAccount(["token": token, "label": "puter"])
            self.supervisor.log.append("[auth] token received from Puter sign-in")
            reply(result)
            self.reloadUI()
        }
    }

    func addAccount(_ d: [String: Any]) -> Any? {
        guard let raw = d["token"] as? String else { return nil }
        let token = Keys.normalizeToken(raw)
        guard !token.isEmpty else {
            return NSError(domain: "app", code: 2,
                           userInfo: [NSLocalizedDescriptionKey: "Token is empty."])
        }
        // Duplicate tokens would double-count the same quota, so refuse them.
        if prefs.accounts.contains(where: { $0.token == token }) {
            return NSError(domain: "app", code: 3,
                           userInfo: [NSLocalizedDescriptionKey: "That token is already added."])
        }
        let label = (d["label"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? "account-\(prefs.accounts.count + 1)"
        var id = label.lowercased().replacingOccurrences(of: " ", with: "-")
        if prefs.accounts.contains(where: { $0.id == id }) {
            id += "-\(prefs.accounts.count + 1)"
        }
        prefs.accounts.append(Account(id: id, label: label, token: token, proxy: nil))
        prefs.save()
        ConfigWriter.write(prefs)
        return ["ok": true, "message": "Added \(label). Restart the server to apply."]
    }

    func removeAccount(_ d: [String: Any]) -> Any? {
        guard let i = d["index"] as? Int, prefs.accounts.indices.contains(i) else { return nil }
        prefs.accounts.remove(at: i)
        prefs.save()
        ConfigWriter.write(prefs)
        return nil
    }

    // MARK: Actions

    func perform(_ what: String) -> Any? {
        switch what {
        case "start":
            supervise()
            return ["ok": true, "message": "Starting…"]
        case "stop":
            supervisor.stopAll()
            return ["ok": true, "message": "Stopped."]
        case "restart":
            supervisor.stopAll { [weak self] in
                guard let self else { return }
                self.prefs = Prefs.load()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.supervise() }
            }
            return ["ok": true, "message": "Restarting…"]
        case "torstart":
            supervisor.startTor()
            return ["ok": true, "message": "Starting Tor…"]
        case "torstop":
            supervisor.stopTor()
            return ["ok": true, "message": "Tor stopped."]
        case "diagnostics":
            return runDiagnostics()
        default:
            return ["ok": false, "message": "Unknown action."]
        }
    }

    /// Diagnostics are deliberately read-only: they report facts rather than
    /// changing state, so the user can run them without side effects.
    func runDiagnostics() -> Any? {
        var lines: [String] = []

        func check(_ name: String, _ ok: Bool, _ detail: String = "") {
            lines.append("\(ok ? "PASS" : "FAIL")  \(name)\(detail.isEmpty ? "" : "  — \(detail)")")
        }

        let node = Supervisor.bundledNode()
        check("Node runtime", node != nil, node ?? "not found")

        let tor = Supervisor.bundledTor()
        check("Tor binary", tor != nil, tor ?? "not found")

        let entry = Supervisor.serverEntry()
        check("Server code", entry != nil, entry ?? "not installed")

        check("Port \(prefs.port) free or ours",
              !Net.portOpen(UInt16(prefs.port)) || supervisor.serverRunning)

        check("Tor SOCKS on 9050", Net.portOpen(9050),
              supervisor.torBootstrapped ? "bootstrapped" : "listening" )

        check("Config file", FileManager.default.fileExists(atPath: AppPaths.env.path),
              AppPaths.env.path)

        check("Accounts configured", !prefs.accounts.isEmpty,
              "\(prefs.accounts.count) account(s)")

        if let entry {
            let mods = (entry as NSString).deletingLastPathComponent
                .replacingOccurrences(of: "/src/index.js", with: "") + "/node_modules"
            check("node_modules", FileManager.default.fileExists(atPath: mods), mods)
        }

        if supervisor.serverRunning {
            let url = URL(string: "http://127.0.0.1:\(prefs.port)/health")!
            var req = URLRequest(url: url)
            req.timeoutInterval = 3
            let sem = DispatchSemaphore(value: 0)
            var body = ""
            URLSession.shared.dataTask(with: req) { d, _, _ in
                if let d { body = String(data: d, encoding: .utf8) ?? "" }
                sem.signal()
            }.resume()
            _ = sem.wait(timeout: .now() + 4)
            check("Health endpoint", !body.isEmpty, body)
        }

        let text = lines.joined(separator: "\n")
        DispatchQueue.main.async {
            self.webView.evaluateJavaScript(
                "document.getElementById('diag').textContent = \(Self.jsLiteral(text));",
                completionHandler: nil)
        }
        return ["ok": true, "message": "Diagnostics complete."]
    }
}

// MARK: - Helpers

extension Prefs {
    func pipe<T>(_ f: (Prefs) -> T) -> T { f(self) }
}

extension Supervisor {
    /// The webview needs to distinguish "starting" from "stopped"; the
    /// published flag alone cannot express it.
    var serverProcStarting: Bool {
        serverRunning == false && lastError == nil
    }
}
