//
//  HostBridge.swift
//  QueryHop
//
//  The native<->JavaScript bridge contract, shared by the host app target,
//  the Safari extension target, and the QueryHopTests unit-test target
//  (issue #41). Everything here is pure and dependency-light so the tests
//  can compile it directly (the test bundle is standalone — no TEST_HOST).
//

import Foundation
import SafariServices

/// Message names the host window and Script.js agree on. The JS side posts
/// `openPreferences` from openPreferences() (Script.js); the host app
/// compares WKScriptMessage.body against it in
/// userContentController(_:didReceive:).
enum HostWindowMessages {
    static let openPreferences = "open-preferences"
}

/// The JavaScript the host window evaluates to talk to Script.js. Keeping
/// the exact literals in one place (and the escaping in one function) lets
/// the unit tests pin the contract without a WKWebView (issue #41).
enum HostWindowJS {

    /// Escape a string for interpolation into a single-quoted JavaScript
    /// string literal. Backslashes are escaped before quotes — the reverse
    /// order would let the quote pass double-escape the backslashes it
    /// adds.
    static func escapeStringLiteral(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
    }

    /// showError: report a failure to open Safari Settings (or read the
    /// extension state). `message` is the system error description (already
    /// localized by AppKit); the "Could not open Safari Settings:" prefix is
    /// added on the JS side from MESSAGES so it follows the host-window
    /// locale (#26). An empty message makes Script.js fall back to the
    /// generic localized sentence.
    static func showError(message: String) -> String {
        "showError('\(escapeStringLiteral(message))')"
    }

    /// show: publish the extension's enabled state.
    /// `useSettingsInsteadOfPreferences` is retained in the signature for
    /// the native caller's compatibility (macOS 13+ phrasing); the copy
    /// itself lives in MESSAGES.
    static func showState(enabled: Bool, useSettingsInsteadOfPreferences: Bool) -> String {
        "show(\(enabled), \(useSettingsInsteadOfPreferences))"
    }
}

/// The browser.runtime.sendNativeMessage <-> Safari web-extension payload
/// contract (issue #41). SafariWebExtensionHandler.beginRequest extracts
/// the incoming message with `message(from:)` and returns
/// `echoResponse(message:)`; the unit tests exercise both without a live
/// NSExtensionContext.
enum NativeMessageCodec {

    /// The userInfo key that carries the message payload: SafariServices'
    /// SFExtensionMessageKey on macOS 11+ (the deployment floor), with the
    /// older "message" literal retained for parity with the handler's
    /// historical availability branch.
    static var messageKey: String {
        if #available(macOS 11.0, *) {
            return SFExtensionMessageKey
        } else {
            return "message"
        }
    }

    /// Extract the payload from a sendNativeMessage extension item.
    static func message(from item: NSExtensionItem?) -> Any? {
        guard let userInfo = item?.userInfo else { return nil }
        return userInfo[messageKey]
    }

    /// The response item beginRequest() returns: an echo of the received
    /// payload (a nil payload is echoed as JSON null) so the browser side
    /// can verify the native host answered.
    static func echoResponse(message: Any?) -> NSExtensionItem {
        let response = NSExtensionItem()
        response.userInfo = [ messageKey: [ "echo": message ] ]
        return response
    }
}
