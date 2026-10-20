// Entry point. This file must be named main.swift: Swift only permits
// top-level expressions there, and every other file is treated as a library.
//
// Two ways in: the normal GUI, and a headless mode used for testing and for
// running the proxy on a machine without a desktop session.

import AppKit
import Foundation

// MARK: - Argument parsing

let args = Array(CommandLine.arguments.dropFirst())

func flag(_ name: String) -> Bool { args.contains("--\(name)") }

var signalSources: [DispatchSourceSignal] = []

func value(_ name: String) -> String? {
    if let i = args.firstIndex(of: "--\(name)"), i + 1 < args.count {
        return args[i + 1]
    }
    return nil
}

// MARK: - Headless

/// Runs the server (and optionally Tor) without a window, printing status to
/// stdout and blocking until interrupted. This is the same code path the GUI
/// uses, so a headless run is a genuine test of the app rather than a parallel
/// implementation that could drift.
func runHeadless() -> Never {
    var prefs = Prefs.load()

    if let t = value("token") {
        prefs.accounts = [Account(id: "primary", label: "primary",
                                  token: Keys.normalizeToken(t), proxy: nil)]
    }
    if let m = value("model") { prefs.defaultModel = m }
    if let p = value("port"), let n = Int(p) { prefs.port = n }
    if let e = value("egress") {
        prefs.proxyMode = (e == "tor") ? .tor : .none
    }
    if prefs.clientKey.isEmpty { prefs.clientKey = Keys.randomHex() }
    if prefs.adminKey.isEmpty { prefs.adminKey = Keys.randomHex() }
    prefs.setupComplete = true
    prefs.save()

    // Discover and verify before starting, exactly as the GUI does at first run.
    if prefs.accounts.isEmpty || flag("discover") {
        let d = Autopilot.discover(seed: prefs.accounts)
        for n in d.notes { print("[discover] \(n)") }
        for w in d.warnings { print("[discover] WARNING \(w)") }
        if !d.accounts.isEmpty {
            let proxy = prefs.proxyMode == .tor ? "socks5h://127.0.0.1:9050" : nil
            let (kept, dropped) = Autopilot.prune(d.accounts, proxy: proxy) { print("[verify] \($0)") }
            for x in dropped { print("[verify] dropped \(x)") }
            prefs.accounts = kept
            prefs.save()
        }
    }

    guard !prefs.accounts.isEmpty else {
        FileHandle.standardError.write(Data("No usable Puter accounts.\n".utf8))
        exit(1)
    }

    let supervisor = Supervisor(port: UInt16(prefs.port))

    if prefs.proxyMode == .tor {
        supervisor.startTor()
        print("[headless] waiting for Tor…")
        if supervisor.waitFor(9050, timeout: 60) {
            print("[headless] Tor listening on 9050")
        } else {
            print("[headless] WARNING: Tor did not come up; requests will fail over")
        }
    }

    supervisor.startServer(prefs: prefs)
    print("[headless] waiting for server on \(prefs.port)…")

    guard supervisor.waitFor(UInt16(prefs.port), timeout: 60) else {
        print("[headless] ERROR: server did not start")
        print(supervisor.log.snapshot().joined(separator: "\n"))
        exit(1)
    }

    print("[headless] READY http://127.0.0.1:\(prefs.port)")
    print("[headless] client key: \(prefs.clientKey)")
    print("[headless] admin key:  \(prefs.adminKey)")

    if flag("once") {
        // Used by tests: report readiness and leave the server running in the
        // background until this process is killed externally.
        fflush(stdout)
    }

    // Keep the process alive; children die with it. Signal handlers must not
    // touch the object graph, so ignore the default disposition and let a
    // dispatch source run the teardown on the main queue instead. Without this
    // the parent exits and leaves Tor holding 9050.
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    for sig in [SIGTERM, SIGINT] {
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        src.setEventHandler {
            let note = "[headless] shutting down\n"
            FileHandle.standardError.write(Data(note.utf8))
            supervisor.stopAllSynchronously()
            exit(0)
        }
        src.resume()
        signalSources.append(src)   // keep them alive
    }
    dispatchMain()
}

// MARK: - Self test

/// Verifies the bundle is internally consistent: binaries present, server code
/// installed, config writable. Exits non-zero on failure so it can gate a build.
func runSelfTest() -> Never {
    var failures = 0

    func check(_ name: String, _ ok: Bool, _ detail: String = "") {
        print("\(ok ? "PASS" : "FAIL")  \(name)\(detail.isEmpty ? "" : "  — \(detail)")")
        if !ok { failures += 1 }
    }

    print("Puter Proxy self-test")
    print("  bundle: \(Bundle.main.bundlePath)")
    print("")

    let node = Supervisor.bundledNode()
    check("Node runtime", node != nil, node ?? "not found")

    let tor = Supervisor.bundledTor()
    check("Tor binary", tor != nil, tor ?? "not found")

    let entry = Supervisor.serverEntry()
    check("Server entry point", entry != nil, entry ?? "not installed")

    check("Config directory writable",
          FileManager.default.isWritableFile(atPath: AppPaths.support.path),
          AppPaths.support.path)

    // Actually execute the bundled node, rather than trusting file existence.
    if let node {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["-e", "process.stdout.write(process.version)"]
        let pipe = Pipe()
        p.standardOutput = pipe
        do {
            try p.run()
            let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(),
                             encoding: .utf8) ?? ""
            p.waitUntilExit()
            check("Node executes", out.hasPrefix("v"), out)
        } catch {
            check("Node executes", false, error.localizedDescription)
        }
    }

    // The server's dependencies must be resolvable from its own directory.
    if entry != nil {
        let root = AppPaths.serverRoot.path
        for mod in ["express", "helmet", "undici", "@heyputer/puter.js"] {
            let path = "\(root)/node_modules/\(mod)/package.json"
            check("dependency \(mod)", FileManager.default.fileExists(atPath: path))
        }
    }

    if let tor {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tor)
        p.arguments = ["--version"]
        var env = ProcessInfo.processInfo.environment
        env["DYLD_LIBRARY_PATH"] = (tor as NSString).deletingLastPathComponent
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = Pipe()
        do {
            try p.run()
            let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(),
                             encoding: .utf8) ?? ""
            p.waitUntilExit()
            check("Tor executes", out.contains("Tor version"),
                  out.split(separator: "\n").first.map(String.init) ?? "")
        } catch {
            check("Tor executes", false, error.localizedDescription)
        }
    }

    print("")
    print(failures == 0 ? "All checks passed." : "\(failures) check(s) failed.")
    exit(failures == 0 ? 0 : 1)
}

// MARK: - Discover only

func runDiscover() -> Never {
    let d = Autopilot.discover(seed: Prefs.load().accounts)
    print("Discovered \(d.accounts.count) account(s):")
    for a in d.accounts {
        print("  - \(a.label)  [\(Keys.tokenFingerprint(a.token))]  \(a.token.count) chars")
    }
    for n in d.notes { print("  note: \(n)") }
    for w in d.warnings { print("  warning: \(w)") }
    exit(d.accounts.isEmpty ? 1 : 0)
}

// MARK: - Dispatch

if flag("self-test") {
    runSelfTest()
} else if flag("discover") && !flag("headless") {
    runDiscover()
} else if flag("headless") {
    runHeadless()
} else {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(NSApplication.ActivationPolicy.regular)
    app.run()
}
