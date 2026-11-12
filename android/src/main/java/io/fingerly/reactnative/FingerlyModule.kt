package io.fingerly.reactnative

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import io.fingerly.sdk.bridge.FingerlyBridge
import io.fingerly.sdk.bridge.BridgeCallback

/**
 * The React Native module.
 *
 * It does three things: hand the configuration to the native SDK, call it, and
 * return the JSON it produced. There is deliberately no logic here at all —
 * every decision about what to collect and how to weigh it lives in the SDK,
 * where the iOS module's Swift equivalent has its own copy of the same
 * arrangement. A bridge that made judgements would be a fourth place to keep a
 * rule in step.
 *
 * # Why the work is not on the main thread
 *
 * `identify` reads a megabyte of `/proc/self/maps`, walks the mount table and
 * makes a TLS handshake. React Native calls a module method on its own native
 * modules thread, and everything below hands off to the SDK's own coroutine
 * scope immediately — so a fingerprint never touches the thread that draws the
 * customer's UI.
 */
class FingerlyModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

    /**
     * The name JavaScript looks the module up by.
     *
     * `NativeModules.Fingerly`, matching the iOS module exactly. The two have to
     * agree: `src/index.ts` looks up one name and would report "run pod
     * install" on whichever platform disagreed.
     */
    override fun getName(): String = "Fingerly"

    /**
     * Values available synchronously to JavaScript.
     *
     * Only the version. Anything expensive here would run during bridge
     * startup, which is the one place a fraud SDK must not cost anything — an
     * app that is slow to launch because of us is an app that removes us.
     */
    override fun getConstants(): Map<String, Any> =
        mapOf("sdkVersion" to FingerlyBridge.sdkVersion())

    /**
     * `playIntegrityCloudProjectNumber` is the app's Google Cloud project
     * number for Play Integrity, 0 for none: a JavaScript number, so a double
     * here. It takes effect only when the app also depends on the optional
     * `io.fingerly:fingerly-play-integrity` artifact, which the native SDK
     * finds on its own; without it the number is ignored.
     */
    @ReactMethod
    fun configure(
        apiKey: String,
        endpoint: String,
        platform: String,
        consent: String,
        playIntegrityCloudProjectNumber: Double,
    ) {
        // The React context rather than the Activity. An SDK holding an
        // Activity would keep a destroyed screen alive for as long as the
        // client lives, and this one is deliberately long-lived.
        //
        // `consent` is always sent by `src/index.ts`, `pending` when the app
        // passed none, so the state is set rather than left as it was.
        FingerlyBridge.configure(
            reactApplicationContext,
            apiKey,
            endpoint,
            platform,
            consent,
            playIntegrityCloudProjectNumber.toLong(),
        )
    }

    /** Applies to the configured client and to any call it has in flight. */
    @ReactMethod
    fun setConsent(state: String) {
        FingerlyBridge.setConsent(state)
    }

    /**
     * `automatic` is accepted for parity with iOS and not read: the native
     * Android bridge has no such option yet, so every call is identified as
     * a user's call.
     */
    @ReactMethod
    @Suppress("UNUSED_PARAMETER")
    fun identify(tag: String?, submit: Boolean, automatic: Boolean, promise: Promise) {
        FingerlyBridge.identify(tag, submit, settle(promise))
    }

    @ReactMethod
    fun collect(promise: Promise) {
        FingerlyBridge.collect(settle(promise))
    }

    /**
     * Deletes the install record, for a user's erasure or account deletion.
     *
     * Resolves with nothing once no record remains, and otherwise rejects with
     * `delete_failed`, the code the iOS module uses for the same failure. A
     * small file delete, done here on the native modules thread rather than
     * handed off: it needs neither configuration nor consent.
     */
    @ReactMethod
    fun deleteStoredIdentity(promise: Promise) {
        val deleted = try {
            FingerlyBridge.deleteStoredIdentity(reactApplicationContext)
        } catch (error: Throwable) {
            false
        }
        if (deleted) {
            promise.resolve(null)
        } else {
            promise.reject(DELETE_FAILED, "Fingerly could not delete its stored install record")
        }
    }

    /**
     * Resolve or reject, once.
     *
     * The rejection code is the HTTP status where there was one, as a string,
     * so a caller can branch on 401 (the key is wrong) or 402 (the organisation
     * is not accepting traffic) without parsing a message. Both are the
     * customer's configuration rather than the user's behaviour, and an app
     * that retries either is an app that drains a battery over a typo. A call
     * refused for want of consent arrives as `consent_required`, which
     * `src/index.ts` turns into a `ConsentError`.
     */
    private fun settle(promise: Promise): BridgeCallback = object : BridgeCallback {
        override fun onSuccess(json: String) {
            promise.resolve(json)
        }

        override fun onError(code: String, message: String) {
            promise.reject(code, message)
        }

        override fun onError(code: String, message: String, retryAfterMs: Long?) {
            if (retryAfterMs == null) {
                onError(code, message)
                return
            }
            // `userInfo.retryAfterMs` is where the JS side reads it, on both platforms.
            promise.reject(code, message, Arguments.createMap().apply { putDouble("retryAfterMs", retryAfterMs.toDouble()) })
        }
    }

    private companion object {
        const val DELETE_FAILED = "delete_failed"
    }
}
