//
//  NativeMessageCodecTests.swift
//  QueryHop
//
//  Unit tests for the browser.runtime.sendNativeMessage payload contract
//  (Shared/HostBridge.swift) — the piece of
//  SafariWebExtensionHandler.beginRequest that is exercised without a live
//  NSExtensionContext (issue #41).
//

import XCTest
import SafariServices

final class NativeMessageCodecTests: XCTestCase {

    func testMessageKeyIsSafariServicesKey() {
        // The deployment floor is macOS 11.5, so the handler always uses the
        // modern SafariServices key.
        XCTAssertEqual(NativeMessageCodec.messageKey, SFExtensionMessageKey)
    }

    func testMessageIsExtractedFromUserInfo() {
        let item = NSExtensionItem()
        item.userInfo = [ SFExtensionMessageKey: ["action": "redirect", "url": "https://search.example.org/?q=a%20b"] ]
        XCTAssertEqual(
            NativeMessageCodec.message(from: item) as? [String: String],
            ["action": "redirect", "url": "https://search.example.org/?q=a%20b"]
        )
    }

    func testMessageIsNilWithoutItemOrUserInfo() {
        XCTAssertNil(NativeMessageCodec.message(from: NSExtensionItem()))
        XCTAssertNil(NativeMessageCodec.message(from: nil))
    }

    func testEchoResponseWrapsThePayload() {
        let payload: [String: Any] = ["action": "redirect"]
        let response = NativeMessageCodec.echoResponse(message: payload)
        let echo = response.userInfo?[SFExtensionMessageKey] as? [String: Any]
        XCTAssertEqual(echo?["echo"] as? [String: String], ["action": "redirect"])
    }

    func testEchoResponseNilPayloadBecomesNull() {
        let response = NativeMessageCodec.echoResponse(message: nil)
        let echo = response.userInfo?[SFExtensionMessageKey] as? [String: Any]
        XCTAssertTrue(echo?["echo"] is NSNull, "a nil payload must be echoed as JSON null (NSNull)")
    }
}
