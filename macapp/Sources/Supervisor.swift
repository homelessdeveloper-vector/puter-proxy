import Foundation

// MARK: - Log buffer

/// Bounded, thread-safe log so a long-running server cannot grow memory without
/// limit. The UI reads snapshots rather than subscribing to every line.
final class LogBuffer: @unchecked Sendable {
    private var lines: [String] = []
    private let lock = NSLock()
    private let cap = 600

    func append(_ s: String) {
        lock.lock()
        lines.append(s)
        if lines.count > cap { lines.removeFirst(lines.count - cap) }
        lock.unlock()
    }

    func snapshot() -> [String] {
        lock.lock(); defer { lock.unlock() }
        return lines
    }

    func clear() {
        lock.lock(); lines.removeAll(); lock.unlock()
    }
}

// MARK: - TCP probe

enum Net {
    /// A real connect, not a sleep. Used to decide when Tor is accepting work
    /// and when the server is listening, so startup timing is measured rather
    /// than guessed.
    static func portOpen(_ port: UInt16, host: String = "127.0.0.1", timeout: TimeInterval = 0.4) -> Bool {
        var hints = addrinfo()
        hints.ai_family = AF_INET
        hints.ai_socktype = SOCK_STREAM
        hints.ai_protocol = IPPROTO_TCP
        hints.ai_flags = AI_NUMERICSERV
        var res: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, String(port), &hints, &res) == 0, let info = res else {
            return false
        }
        defer { freeaddrinfo(info) }

        let fd = socket(info.pointee.ai_family, info.pointee.ai_socktype, info.pointee.ai_protocol)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        // Non-blocking connect so a blackholed port cannot wedge the UI.
        let flags = fcntl(fd, F_GETFL, 0)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)

        let rc = connect(fd, info.pointee.ai_addr, info.pointee.ai_addrlen)
        if rc == 0 { return true }
        guard errno == EINPROGRESS else { return false }

        var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        guard poll(&pfd, 1, Int32(timeout * 1000)) > 0 else { return false }

        var err: Int32 = 0
        var len = socklen_t(MemoryLayout<Int32>.size)
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len)
        return err == 0
    }
}

// MARK: - Supervisor

/// Owns both child processes: the bundled Tor daemon and the bundled Node
/// server.
///
/// `Process` is used directly rather than a shell so nothing depends on the
/// user's PATH, no quoting is involved, and termination is deterministic. Both
/// children inherit an explicit environment, which also means the server can be
/// pointed at an Application Support config without touching the bundle.
final class Supervisor: ObservableObject {

    @Published private(set) var torRunning = false
    @Published private(set) var torBootstrapped = false
    @Published private(set) var serverRunning = false
    @Published private(set) var lastError: String?

    let log = LogBuffer()

    private var torProc: Process?
    private var serverProc: Process?
    private var torPipe: Pipe?
    private var serverPipe: Pipe?
    /// Set while Tor is meant to be up, so the crash-restart handler knows the
    /// difference between "it died" and "we deliberately stopped it".
    private var wantTor = false
    private var torRestarts = 0
    /// False when Tor on 9050 was already running before we started; an adopted
    /// daemon must survive our exit.
    private var torIsOwned = true
    private let queue = DispatchQueue(label: "puterproxy.supervisor")
    private let port: UInt16

    init(port: UInt16 = 8080) {
        self.port = port
    }

    // MARK: Binary resolution

    /// Resolution order is: bundled runtime, then Homebrew, then Tor Browser.
    /// A missing binary must produce a message the wizard can act on, not a
    /// silent no-op.
    static func bundledNode() -> String? {
        let p = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Resources/runtime/node").path
        if FileManager.default.isExecutableFile(atPath: p) { return p }
        for c in ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        where FileManager.default.isExecutableFile(atPath: c) { return c }
        return nil
    }

    static func bundledTor() -> String? {
        let p = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Resources/runtime/tor").path
        if FileManager.default.isExecutableFile(atPath: p) { return p }
        for c in ["/opt/homebrew/bin/tor", "/usr/local/bin/tor"]
        where FileManager.default.isExecutableFile(atPath: c) { return c }
        let tb = "/Applications/Tor Browser.app/Contents/MacOS/Tor/tor"
        if FileManager.default.isExecutableFile(atPath: tb) { return tb }
        return nil
    }

    static func serverEntry() -> String? {
        let installed = AppPaths.serverRoot.appendingPathComponent("src/index.js").path
        if FileManager.default.fileExists(atPath: installed) { return installed }
        return nil
    }

    var serverURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    // MARK: Tor

    func startTor() {
        queue.async { [weak self] in
            guard let self else { return }
            self.wantTor = true
            if self.torProc?.isRunning == true {
                self.log.append("[tor] already running")
                return
            }
            if Net.portOpen(9050) {
                // Adopt, do not own. Something else (Tor Browser, a Homebrew
                // service) is already serving SOCKS; we point at it and must
                // never terminate it on exit, because it is not ours.
                self.log.append("[tor] reusing the existing daemon on 9050 (not owned by this app)")
                self.torIsOwned = false
                DispatchQueue.main.async {
                    self.torRunning = true
                    self.torBootstrapped = true
                }
                return
            }
            guard let bin = Supervisor.bundledTor() else {
                self.fail("Tor binary not found. Reinstall, or run `brew install tor`.")
                return
            }

            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: bin)
            proc.arguments = [
                "--SocksPort", "9050",
                "--DataDirectory", AppPaths.torDir.path,
                "--Log", "notice file \(AppPaths.torLog.path)",
                // No ControlPort on purpose: nothing needs to reconfigure Tor
                // at runtime, and an unauthenticated control port is a
                // well-known local privilege problem.
                "--CookieAuthentication", "0",
            ]
            // Tor links libevent with @executable_path, so it must be findable
            // next to the binary inside the bundle.
            var env = ProcessInfo.processInfo.environment
            env["DYLD_LIBRARY_PATH"] = (bin as NSString).deletingLastPathComponent
            proc.environment = env

            let pipe = Pipe()
            proc.standardOutput = pipe
            proc.standardError = pipe
            self.torPipe = pipe

            pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
                let d = h.availableData
                guard !d.isEmpty, let s = String(data: d, encoding: .utf8) else { return }
                for line in s.split(separator: "\n") {
                    let l = String(line)
                    self?.log.append("[tor] \(l)")
                    if l.contains("Bootstrapped 100%") {
                        DispatchQueue.main.async { self?.torBootstrapped = true }
                    }
                }
            }

            // Tor exits on its own only if it crashes; without this watchdog a
            // silently dead daemon would leave the UI saying "running" while
            // every request fails. Restart it, but stop after three tries so a
            // genuine configuration error is surfaced instead of spinning.
            proc.terminationHandler = { [weak self] p in
                guard let self else { return }
                self.log.append("[tor] exited status \(p.terminationStatus)")
                DispatchQueue.main.async {
                    self.torRunning = false
                    self.torBootstrapped = false
                }
                guard self.wantTor, self.torRestarts < 3 else { return }
                self.torRestarts += 1
                self.log.append("[tor] restarting (\(self.torRestarts)/3)")
                DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                    self.startTor()
                }
            }

            do {
                try proc.run()
                self.torProc = proc
                self.torIsOwned = true
                DispatchQueue.main.async { self.torRunning = true }
                self.log.append("[tor] started pid \(proc.processIdentifier)")
            } catch {
                self.fail("Could not start Tor: \(error.localizedDescription)")
            }
        }
    }

    // MARK: Server

    func startServer(prefs: Prefs) {
        queue.async { [weak self] in
            guard let self else { return }
            if self.serverProc?.isRunning == true {
                self.log.append("[server] already running")
                return
            }
            guard let node = Supervisor.bundledNode() else {
                self.fail("Node.js runtime not found inside the app bundle.")
                return
            }
            guard let entry = Supervisor.serverEntry() else {
                self.fail("Server code is not installed. Run the setup wizard again.")
                return
            }
            if Net.portOpen(self.port) {
                self.fail("Port \(self.port) is already in use. Close the other instance or change the port.")
                return
            }

            // Config is rewritten on every start so the app is always the
            // source of truth; a stale .env cannot outlive a settings change.
            let warnings = ConfigWriter.write(prefs)
            for w in warnings { self.log.append("[config] \(w)") }

            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: node)
            // Launch through the shim so the server dies with the app even when
            // the app is force-killed and never gets to run stopServer().
            let launcher = AppPaths.launcherScript ?? entry
            proc.arguments = [launcher]
            proc.currentDirectoryURL = AppPaths.serverRoot

            var env = ProcessInfo.processInfo.environment
            env["NODE_ENV"] = "production"
            // dotenv would otherwise read a .env from the CWD; point it at the
            // one we just wrote instead of relying on discovery.
            env["PUTER_PROXY_CONFIG"] = AppPaths.env.path
            env["HOME"] = NSHomeDirectory()
            env["PP_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
            env["PP_SERVER_ENTRY"] = entry
            proc.environment = env

            let pipe = Pipe()
            proc.standardOutput = pipe
            proc.standardError = pipe
            self.serverPipe = pipe

            pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
                let d = h.availableData
                guard !d.isEmpty, let s = String(data: d, encoding: .utf8) else { return }
                for line in s.split(separator: "\n") {
                    self?.log.append("[server] \(line)")
                }
            }

            proc.terminationHandler = { [weak self] p in
                self?.log.append("[server] exited status \(p.terminationStatus)")
                DispatchQueue.main.async { self?.serverRunning = false }
            }

            do {
                try proc.run()
                self.serverProc = proc
                self.log.append("[server] started pid \(proc.processIdentifier)")
                // Mark running only once the port answers, so the UI never
                // claims "running" for a process that died on a config error.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    if Net.portOpen(self.port) {
                        DispatchQueue.main.async { self.serverRunning = true }
                        self.log.append("[server] listening on \(self.serverURL.absoluteString)")
                    } else {
                        self.fail("Server did not open port \(self.port). Check the log below.")
                    }
                }
            } catch {
                self.fail("Could not start the server: \(error.localizedDescription)")
            }
        }
    }

    // MARK: Stop

    func stopServer() {
        queue.async { [weak self] in
            guard let self, let proc = self.serverProc, proc.isRunning else { return }
            self.log.append("[server] stopping")
            // SIGTERM first: the server has a graceful shutdown handler that
            // evicts SDK clients and closes sockets.
            proc.terminate()
            let deadline = Date().addingTimeInterval(5)
            while proc.isRunning && Date() < deadline {
                usleep(100_000)
            }
            if proc.isRunning {
                self.log.append("[server] did not exit in 5s; sending SIGKILL")
                kill(proc.processIdentifier, SIGKILL)
            }
            self.serverProc = nil
            self.serverPipe?.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async { self.serverRunning = false }
        }
    }

    func stopTor() {
        queue.async { [weak self] in
            guard let self else { return }
            // Clear the intent first: the termination handler reads it to decide
            // whether this exit was a crash worth restarting.
            self.wantTor = false
            self.torRestarts = 0
            // Never kill a daemon that was already running when we started.
            guard self.torIsOwned else {
                self.log.append("[tor] leaving the adopted daemon running")
                self.torProc = nil
                DispatchQueue.main.async {
                    self.torRunning = false
                    self.torBootstrapped = false
                }
                return
            }
            guard let proc = self.torProc, proc.isRunning else { return }
            self.log.append("[tor] stopping")
            proc.terminate()
            let deadline = Date().addingTimeInterval(4)
            while proc.isRunning && Date() < deadline { usleep(100_000) }
            if proc.isRunning { kill(proc.processIdentifier, SIGKILL) }
            self.torProc = nil
            self.torPipe?.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                self.torRunning = false
                self.torBootstrapped = false
            }
        }
    }

    func stopAll(_ done: (() -> Void)? = nil) {
        stopServer()
        // Give the server its grace period before tearing down Tor underneath it.
        queue.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            self?.stopTor()
            done?()
        }
    }

    /// Blocking teardown for `applicationWillTerminate`, which returns void and
    /// cannot await. Uses the same grace period as stopServer/stopTor but waits
    /// for it, because the process is about to disappear.
    func stopAllSynchronously() {
        for (label, proc) in [("server", serverProc), ("tor", torProc)] {
            // Skip adopted process groups entirely.
            if label == "tor" && !torIsOwned { continue }
            guard let proc, proc.isRunning else { continue }
            log.append("[\(label)] stopping")
            proc.terminate()
            let deadline = Date().addingTimeInterval(label == "server" ? 5 : 4)
            while proc.isRunning && Date() < deadline { usleep(100_000) }
            if proc.isRunning { kill(proc.processIdentifier, SIGKILL) }
        }
        serverProc = nil
        torProc = nil
    }

    // MARK: Helpers

    private func fail(_ msg: String) {
        log.append("[error] \(msg)")
        DispatchQueue.main.async { self.lastError = msg }
    }

    /// Synchronous readiness wait. Runs on the supervisor queue only.
    @discardableResult
    func waitFor(_ port: UInt16, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if Net.portOpen(port) { return true }
            usleep(250_000)
        }
        return false
    }
}
