import AppKit
import WebKit

// MARK: - Puter sign-in window

/// Hosts Puter's own sign-in page in a WKWebView so the operator can create an
/// account or add an existing one, and hands the resulting token back to the
/// app.
///
/// The split of responsibility matters: Puter's servers render the form, verify
/// the email, and mint the token. This window never sees a password and has no
/// way to fabricate an identity — it only carries the result back. That is the
/// difference between "sign-up supported" and "accounts farmed".
final class SignInWindow: NSObject, WKScriptMessageHandler, WKNavigationDelegate, NSWindowDelegate {

    private var window: NSWindow?
    private var webView: WKWebView?
    private var completion: ((String?, String?) -> Void)?
    private var finished = false

    /// Presents the window. `completion` runs on the main thread with either a
    /// token or a human-readable failure, and exactly once.
    func present(completion: @escaping (String?, String?) -> Void) {
        self.completion = completion
        self.finished = false

        let config = WKWebViewConfiguration()
        // Non-persistent: the token is copied out immediately and the session
        // discarded, so signing in to a second account is not blocked by the
        // cookie from the first.
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "puterAuth")

        let frame = NSRect(x: 0, y: 0, width: 520, height: 460)
        let web = WKWebView(frame: frame, configuration: config)
        web.navigationDelegate = self
        self.webView = web

        let win = NSWindow(contentRect: frame,
                           styleMask: [.titled, .closable],
                           backing: .buffered,
                           defer: false)
        win.title = "Add a Puter account"
        win.contentView = web
        win.delegate = self
        win.center()
        win.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        self.window = win

        // A file:// page has an opaque origin, and Puter's signIn refuses to run
        // on one ("unsupported_origin"). Loading the markup with a remote base
        // URL gives the document a real origin so the popup handshake works.
        guard let html = SignInWindow.pageHTML() else {
            finish(nil, "The sign-in page is missing from the app bundle.")
            return
        }
        let base = URL(string: "https://puter.com/")!
        web.loadHTMLString(html, baseURL: base)
    }

    /// The page is bundled, so the window works offline apart from the library
    /// itself. Loaded as text rather than a file URL for the origin reason above.
    private static func pageHTML() -> String? {
        let candidates = [
            Bundle.main.resourceURL?.appendingPathComponent("account.html"),
            Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/account.html"),
        ].compactMap { $0 }
        for url in candidates {
            if let s = try? String(contentsOf: url, encoding: .utf8) { return s }
        }
        return nil
    }

    // MARK: Message from the page

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "puterAuth",
              let body = message.body as? [String: Any] else { return }

        let ok = body["ok"] as? Bool ?? false
        if ok, let token = body["token"] as? String, !token.isEmpty {
            let user = (body["username"] as? String) ?? ""
            finish(token, nil, username: user)
        } else {
            // Leave the window open: the common failure is a closed popup, and
            // the operator can simply press the button again.
            let err = (body["error"] as? String) ?? "Sign-in did not complete."
            NSLog("[puterauth] %@", err)
        }
    }

    // MARK: Lifecycle

    func windowWillClose(_ n: Notification) {
        // Closing the window without a token counts as a cancel.
        finish(nil, "Sign-in was cancelled.")
    }

    private func finish(_ token: String?, _ error: String?, username: String = "") {
        guard !finished else { return }
        finished = true

        webView?.configuration.userContentController
            .removeScriptMessageHandler(forName: "puterAuth")
        window?.delegate = nil
        window?.close()
        window = nil
        webView = nil

        let cb = completion
        completion = nil
        cb?(token, error)
    }
}
