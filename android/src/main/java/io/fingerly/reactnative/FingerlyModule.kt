package io.fingerly.reactnative

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import io.fingerly.sdk.AppChecksProvider
import io.fingerly.sdk.PlayIntegrityProvider
import io.fingerly.sdk.appchecks.FingerlyAppChecks
import io.fingerly.sdk.bridge.BridgeCallback
import io.fingerly.sdk.bridge.FingerlyBridge
import io.fingerly.sdk.playintegrity.FingerlyPlayIntegrity

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
 * `identify` reads `/proc/self/maps`, walks the mount table and makes a TLS
 * handshake. React Native calls a module method on its own native modules
 * thread, and everything below hands off to the SDK's own coroutine scope
 * immediately — so a fingerprint never touches the thread that draws the
 * customer's UI.
 */
class FingerlyModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

    private val optionalAppChecks: AppChecksProvider? by lazy(LazyThreadSafetyMode.PUBLICATION) {
        try {
            FingerlyAppChecks()
        } catch (_: LinkageError) {
            null
        }
    }

    private val optionalPlayIntegrity: PlayIntegrityProvider? by lazy(LazyThreadSafetyMode.PUBLICATION) {
        try {
            FingerlyPlayIntegrity()
        } catch (_: LinkageError) {
            null
        }
    }

    /** Why the last `configure` was refused, or null when it was accepted. */
    @Volatile private var configurationError: String? = null

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
     * number for Play Integrity, `<= 0` for none: a JavaScript number, so a
     * `Double` here. Optional `io.fingerly:fingerly-app-checks` and
     * `io.fingerly:fingerly-play-integrity` providers are wired directly
     * (without `Class.forName` reflection) when the host app links them, while
     * preserving any custom providers pre-registered on [FingerlyBridge].
     */
    @ReactMethod
    fun configure(
        apiKey: String,
        endpoint: String,
        platform: String,
        consent: String,
        playIntegrityCloudProjectNumber: Double,
    ) {
        val projectNumber = playIntegrityCloudProjectNumber.toLong().takeIf { it > 0L }

        // A project number with no provider to use it would leave Play
        // Integrity off without a word. `configure` returns nothing to
        // JavaScript, so the configuration is refused, nothing is changed, and
        // every later `identify` and `collect` rejects with
        // `play_integrity_unavailable` until a complete configuration replaces it.
        val playIntegrity = optionalPlayIntegrity
        configurationError =
            if (projectNumber != null && playIntegrity == null && !FingerlyBridge.hasPlayIntegrityProvider()) {
                PLAY_INTEGRITY_UNAVAILABLE_MESSAGE
            } else {
                null
            }
        if (configurationError != null) return

        optionalAppChecks?.let(FingerlyBridge::setAppChecks)
        // A Play Integrity provider the app registered by hand is kept.
        if (projectNumber != null && playIntegrity != null && !FingerlyBridge.hasPlayIntegrityProvider()) {
            FingerlyBridge.setPlayIntegrity(playIntegrity, projectNumber)
        }

        FingerlyBridge.configure(
            reactApplicationContext,
            apiKey,
            endpoint,
            platform,
            consent,
            projectNumber,
        )
    }

    /** Applies to the configured client and to any call it has in flight. */
    @ReactMethod
    fun setConsent(state: String) {
        FingerlyBridge.setConsent(state)
    }

    /**
     * Forwards `tag`, `submit`, and `automatic` to the native Android `0.3.0`
     * bridge.
     */
    @ReactMethod
    fun identify(tag: String?, submit: Boolean, automatic: Boolean, promise: Promise) {
        if (refuseUnconfigured(promise)) return
        FingerlyBridge.identify(tag, submit, automatic, settle(promise))
    }

    @ReactMethod
    fun collect(promise: Promise) {
        if (refuseUnconfigured(promise)) return
        FingerlyBridge.collect(settle(promise))
    }

    /** Rejects the call with the stored configuration error, if there is one. */
    private fun refuseUnconfigured(promise: Promise): Boolean {
        val error = configurationError ?: return false
        promise.reject(PLAY_INTEGRITY_UNAVAILABLE, error)
        return true
    }

    /**
     * Atomically deletes the local `install_id` install record and persistent
     * `AndroidKeyStore` v3 attestation signing key.
     *
     * Strictly for user-initiated GDPR / privacy erasure requests ("Delete My
     * Data" or account erasure), never for routine logout or session rotation.
     * Resolves with nothing once neither record nor key remains, and otherwise
     * rejects with `delete_failed`, matching the iOS module.
     */
    @ReactMethod
    fun deleteStoredIdentity(promise: Promise) {
        val deleted = try {
            FingerlyBridge.deleteStoredIdentity(reactApplicationContext)
        } catch (_: Throwable) {
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
     * is not accepting traffic) without parsing a message. A call refused for
     * want of consent arrives as `consent_required`, which `src/index.ts` turns
     * into a `ConsentError`.
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
            promise.reject(
                code,
                message,
                Arguments.createMap().apply { putDouble("retryAfterMs", retryAfterMs.toDouble()) },
            )
        }
    }

    private companion object {
        const val DELETE_FAILED = "delete_failed"
        const val PLAY_INTEGRITY_UNAVAILABLE = "play_integrity_unavailable"
        const val PLAY_INTEGRITY_UNAVAILABLE_MESSAGE =
            "playIntegrityCloudProjectNumber was set but the io.fingerly:fingerly-play-integrity " +
                "artifact is not on the classpath"
    }
}
