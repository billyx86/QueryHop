//
//  HostWindowContractTests.swift
//  QueryHop
//
//  Drift-guard the native<->host-window contract from the Swift side
//  (issue #41): the MESSAGES table in Script.js, the state hooks in the
//  Main.html locale files, and the "open-preferences" message literal.
//  tests/host-window-i18n.test.js already enforces en/de parity — these
//  tests pin what the *Swift* code depends on, which the JS suite cannot
//  see.
//
//  The host app's Resources directory is bundled into the test bundle as
//  the "HostResources" folder reference (see project.pbxproj).
//

import XCTest

private enum ContractError: Error {
    case missingHostResources
    case missingMessagesTable
    case malformedMessagesTable
}

final class HostWindowContractTests: XCTestCase {

    private func resource(at path: String) throws -> String {
        guard let folder = Bundle(for: type(of: self)).url(forResource: "HostResources", withExtension: nil) else {
            throw ContractError.missingHostResources
        }
        return try String(contentsOf: folder.appendingPathComponent(path), encoding: .utf8)
    }

    // MARK: - Script.js

    func testScriptJSPostsThePinnedOpenPreferencesMessage() throws {
        let js = try resource(at: "Script.js")
        XCTAssertTrue(
            js.contains("postMessage(\"\(HostWindowMessages.openPreferences)\")"),
            "Script.js must post \"\(HostWindowMessages.openPreferences)\" — the host app compares WKScriptMessage.body against HostWindowMessages.openPreferences"
        )
    }

    func testScriptJSDefinesTheBridgeFunctions() throws {
        let js = try resource(at: "Script.js")
        XCTAssertTrue(js.contains("function show("), "Script.js must define show(enabled, useSettings) — the host app evaluates it to publish the extension state")
        XCTAssertTrue(js.contains("function showError("), "Script.js must define showError(message) — the host app evaluates it on the error paths")
    }

    func testMessagesTableCoversTheStateContractInBothLocales() throws {
        let table = try Self.parseMessagesTable(try resource(at: "Script.js"))
        let required = [
            "state_on", "state_off", "state_unknown",
            "open_preferences",
            "native_error_prefix", "native_error_fallback",
        ]
        for locale in ["en", "de"] {
            let keys = table[locale] ?? [:]
            for key in required {
                XCTAssertNotNil(keys[key], "MESSAGES[\"\(locale)\"] must define \"\(key)\"")
            }
        }
        // Compare the two locales' key sets for 1:1 parity (the JS-side
        // i18n-consistency test guards the popup; this guards Script.js).
        let enKeys = Set((table["en"] ?? [:]).keys)
        let deKeys = Set((table["de"] ?? [:]).keys)
        XCTAssertEqual(enKeys, deKeys, "en/de MESSAGES keys must stay in 1:1 parity")
    }

    // MARK: - Main.html locale files

    func testLocaleMainHTMLFilesExposeTheStateHooks() throws {
        // Base.lproj is the English fallback; AppKit picks the bundle by
        // system locale, and Script.js reads <html lang> to pick its
        // MESSAGES table — so the directory and the lang attribute must
        // agree.
        for (directory, lang) in [("Base", "en"), ("de", "de")] {
            let html = try resource(at: "\(directory).lproj/Main.html")
            XCTAssertTrue(
                html.contains("<html lang=\"\(lang)\">"),
                "\(directory).lproj/Main.html must declare lang=\"\(lang)\" — Script.js detects the locale from it"
            )
            for marker in ["state-unknown", "state-on", "state-off", "open-preferences"] {
                XCTAssertTrue(html.contains("class=\"\(marker)\""), "\(directory).lproj/Main.html must keep the .\(marker) hook the JS fills")
            }
            XCTAssertTrue(html.contains("role=\"status\""), "\(directory).lproj/Main.html must keep the live-region markers (#31)")
            XCTAssertTrue(html.contains("Script.js"), "\(directory).lproj/Main.html must load ../Script.js")
        }
    }

    // MARK: - Parsing

    /// The MESSAGES table in Script.js is kept strict-JSON-compatible on
    /// purpose (the comment in Script.js and tests/host-window-i18n.test.js
    /// rely on it): locate `var MESSAGES = {`, scan to the matching brace,
    /// and JSON-parse.
    private static func parseMessagesTable(_ source: String) throws -> [String: [String: String]] {
        let marker = "var MESSAGES = "
        guard let markerRange = source.range(of: marker) else {
            throw ContractError.missingMessagesTable
        }
        let start = source.index(after: markerRange.upperBound)
        var depth = 0
        var sawOpen = false
        var end = start
        // Range<String.Index> is not a Sequence (String.Index is not
        // Strideable) — advance the index explicitly.
        var i = start
        while i < source.endIndex {
            switch source[i] {
            case "{": depth += 1; sawOpen = true
            case "}": depth -= 1
            default: break
            }
            end = i
            if sawOpen, depth == 0 { break }
            i = source.index(after: i)
        }
        guard sawOpen, depth == 0 else { throw ContractError.malformedMessagesTable }
        let block = source[start...end]
        guard let data = block.data(using: .utf8) else { throw ContractError.malformedMessagesTable }
        guard let table = try JSONSerialization.jsonObject(with: data) as? [String: [String: String]] else {
            throw ContractError.malformedMessagesTable
        }
        return table
    }
}
