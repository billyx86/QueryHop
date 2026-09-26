//
//  SafariWebExtensionHandler.swift
//  QueryHop
//

import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(iOS 17.0, macOS 14.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        // The payload key and the echo response live in the shared bridge
        // (Shared/HostBridge.swift), pinned by NativeMessageCodecTests.
        let message = NativeMessageCodec.message(from: request)

        os_log(.default, "Received message from browser.runtime.sendNativeMessage: %@ (profile: %@)", String(describing: message), profile?.uuidString ?? "none")

        context.completeRequest(returningItems: [ NativeMessageCodec.echoResponse(message: message) ], completionHandler: nil)
    }

}
