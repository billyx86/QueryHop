//
//  HostWindowJSTests.swift
//  QueryHop
//
//  Unit tests for the host window's native<->JS bridge helpers
//  (Shared/HostBridge.swift) — the string escaping and the exact JS
//  literals the host window evaluates (issue #41).
//

import XCTest

final class HostWindowJSTests: XCTestCase {

    func testOpenPreferencesMessageIsPinned() {
        // Script.js posts this from openPreferences(); the host app compares
        // WKScriptMessage.body against it. HostWindowContractTests checks
        // the literal appears in Script.js as well.
        XCTAssertEqual(HostWindowMessages.openPreferences, "open-preferences")
    }

    func testEscapeStringLiteralQuotes() {
        XCTAssertEqual(HostWindowJS.escapeStringLiteral("it's"), "it\\'s")
    }

    func testEscapeStringLiteralBackslashes() {
        XCTAssertEqual(HostWindowJS.escapeStringLiteral("C:\\Users"), "C:\\\\Users")
    }

    func testEscapeStringLiteralQuotesAfterBackslashes() {
        // The input is the four characters a \ ' b. The backslash must be
        // doubled first, or the quote pass would escape its own backslash.
        XCTAssertEqual(HostWindowJS.escapeStringLiteral("a\\'b"), "a\\\\\\'b")
    }

    func testEscapeStringLiteralEmptyAndPlain() {
        XCTAssertEqual(HostWindowJS.escapeStringLiteral(""), "")
        XCTAssertEqual(HostWindowJS.escapeStringLiteral("plain text 123"), "plain text 123")
    }

    func testShowErrorJavaScript() {
        XCTAssertEqual(HostWindowJS.showError(message: ""), "showError('')")
        XCTAssertEqual(HostWindowJS.showError(message: "it's broken"), "showError('it\\'s broken')")
        XCTAssertEqual(HostWindowJS.showError(message: "path C:\\x"), "showError('path C:\\\\x')")
    }

    func testShowStateJavaScript() {
        XCTAssertEqual(HostWindowJS.showState(enabled: true, useSettingsInsteadOfPreferences: true), "show(true, true)")
        XCTAssertEqual(HostWindowJS.showState(enabled: true, useSettingsInsteadOfPreferences: false), "show(true, false)")
        XCTAssertEqual(HostWindowJS.showState(enabled: false, useSettingsInsteadOfPreferences: false), "show(false, false)")
    }
}
