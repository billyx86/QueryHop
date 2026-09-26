//
//  ViewController.swift
//  QueryHop
//
//  Created by Billy King on 02/04/2025.
//

import Cocoa
import SafariServices
import WebKit

let extensionBundleIdentifier = "uk.billyking.QueryHop.Extension"

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else {
                DispatchQueue.main.async {
                    // Surface the failure instead of leaving the user on the
                    // generic "unknown" state line. The shared bridge builds
                    // the JS call and escapes the system error description
                    // (Shared/HostBridge.swift, pinned by
                    // QueryHopTests/HostWindowJSTests.swift); the JS side
                    // adds the localized prefix (MESSAGES in Script.js). An
                    // empty message makes showError() fall back to the
                    // generic localized sentence.
                    self.webView.evaluateJavaScript(
                        HostWindowJS.showError(message: error?.localizedDescription ?? "")
                    )
                }
                return
            }

            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript(
                        HostWindowJS.showState(enabled: state.isEnabled, useSettingsInsteadOfPreferences: true)
                    )
                } else {
                    webView.evaluateJavaScript(
                        HostWindowJS.showState(enabled: state.isEnabled, useSettingsInsteadOfPreferences: false)
                    )
                }
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if (message.body as! String != "open-preferences") {
            return;
        }

        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            DispatchQueue.main.async {
                // Only quit once Safari Settings is actually up; otherwise the
                // app would die the moment the user clicked "Quit and Open…"
                // and no settings window would ever appear.
                guard error == nil else {
                    // Escape the message so it is safe to interpolate into a
                    // single-quoted JS string literal. Only the system error
                    // description is passed: the "Could not open Safari
                    // Settings:" prefix is added on the JS side (MESSAGES in
                    // Script.js) so it follows the host-window locale (#26).
                    let message = error!.localizedDescription
                        .replacingOccurrences(of: "\\", with: "\\\\")
                        .replacingOccurrences(of: "'", with: "\\'")
                    self.webView.evaluateJavaScript("showError('\(message)')")
                    return
                }
                NSApplication.shared.terminate(nil)
            }
        }
    }

}
