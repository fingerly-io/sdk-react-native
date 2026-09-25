/// The React Native module.
///
/// It does three things: hand the configuration to the native SDK, call it, and
/// return the JSON it produced. There is deliberately no logic here at all —
/// every decision about what to collect and how to weigh it lives in `Fingerly`,
/// where the Android module's Kotlin equivalent has its own copy of the same
/// arrangement. A bridge that made judgements would be a fourth place to keep a
/// rule in step.
///
/// # Why the work is not on the main thread
///
/// `identify` runs a filesystem sweep, a dyld walk and a TLS handshake. React
/// Native calls a module method on its own module queue by default, and
/// `requiresMainQueueSetup` below says this module does not need the main
/// thread to be constructed — which keeps a fingerprint off the thread that
/// draws the customer's UI.

import Fingerly
import Foundation
import React

@objc(Fingerly)
final class FingerlyModule: NSObject {
    /// React Native asks this before it constructs the module.
    ///
    /// `false` because nothing in this module touches UIKit at construction
    /// time. Answering `true` would put the module's initialisation on the main
    /// thread for no reason, and React Native warns about exactly that.
    @objc
    static func requiresMainQueueSetup() -> Bool { false }

    /// Values available synchronously to JavaScript.
    ///
    /// Only the version. Anything expensive here would run on the main thread
    /// during bridge startup, which is the one place a fraud SDK must not cost
    /// anything — an app that is slow to launch because of us is an app that
    /// removes us.
    @objc
    func constantsToExport() -> [AnyHashable: Any] {
        ["sdkVersion": FingerlyBridge.sdkVersion]
    }

    /// `consent` is always sent by `src/index.ts`, `pending` when the app
    /// passed none. The native bridge reads anything it does not recognise as
    /// `pending`.
    @objc(configure:endpoint:platform:consent:)
    func configure(apiKey: String, endpoint: String, platform: String, consent: String) {
        FingerlyBridge.configure(apiKey: apiKey, endpoint: endpoint, platform: platform, consent: consent)
    }

    /// Applies to the configured client and to any call it has in flight.
    @objc(setConsent:)
    func setConsent(state: String) {
        FingerlyBridge.setConsent(state)
    }

    @objc(identify:submit:resolver:rejecter:)
    func identify(
        tag: String?,
        submit: NSNumber,
        resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        FingerlyBridge.identify(tag: tag, submit: submit.boolValue) { json, error in
            Self.settle(json, error, resolve, reject)
        }
    }

    @objc(collect:rejecter:)
    func collect(
        resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        FingerlyBridge.collect { json, error in
            Self.settle(json, error, resolve, reject)
        }
    }

    /// Deletes the install record, for a user's erasure or account deletion.
    ///
    /// Resolves with nothing once no record remains; a keychain refusal
    /// rejects with `delete_failed`, the code the Android module uses too.
    @objc(deleteStoredIdentity:rejecter:)
    func deleteStoredIdentity(
        resolve: @escaping RCTPromiseResolveBlock,
        reject: @escaping RCTPromiseRejectBlock
    ) {
        if let error = FingerlyBridge.deleteStoredIdentity() {
            let code = error.userInfo["code"] as? String ?? "\(error.code)"
            reject(code, error.localizedDescription, error)
            return
        }
        resolve(nil)
    }

    /// Resolve or reject, once.
    ///
    /// The rejection code is the HTTP status where there was one, as a string,
    /// so a caller can branch on 401 (the key is wrong) or 402 (the
    /// organisation is not accepting traffic) without parsing a message. Both
    /// are the customer's configuration rather than the user's behaviour, and
    /// an app that retries either is an app that drains a battery over a typo.
    ///
    /// A refusal for want of consent carries its own string code in
    /// `userInfo["code"]` (`consent_required`), which takes precedence over the
    /// numeric one. The error itself is passed along, so its `userInfo.state`
    /// reaches JavaScript too.
    private static func settle(
        _ json: String?,
        _ error: NSError?,
        _ resolve: @escaping RCTPromiseResolveBlock,
        _ reject: @escaping RCTPromiseRejectBlock
    ) {
        if let error {
            let code = error.userInfo["code"] as? String ?? "\(error.code)"
            reject(code, error.localizedDescription, error)
            return
        }
        guard let json else {
            reject("-1", "The SDK produced no report", nil)
            return
        }
        resolve(json)
    }
}
