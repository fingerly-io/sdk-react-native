package io.badele.reactnative

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import io.badele.sdk.bridge.BadeleBridge
import io.badele.sdk.bridge.BridgeCallback

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
class BadeleModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

    /**
     * The name JavaScript looks the module up by.
     *
     * `NativeModules.Badele`, matching the iOS module exactly. The two have to
     * agree: `src/index.ts` looks up one name and would report "run pod
     * install" on whichever platform disagreed.
     */
    override fun getName(): String = "Badele"

    /**
     * Values available synchronously to JavaScript.
     *
     * Only the version. Anything expensive here would run during bridge
     * startup, which is the one place a fraud SDK must not cost anything — an
     * app that is slow to launch because of us is an app that removes us.
     */
    override fun getConstants(): Map<String, Any> =
        mapOf("sdkVersion" to BadeleBridge.sdkVersion())

    @ReactMethod
    fun configure(apiKey: String, endpoint: String, platform: String) {
        // The React context rather than the Activity. An SDK holding an
        // Activity would keep a destroyed screen alive for as long as the
        // client lives, and this one is deliberately long-lived.
        BadeleBridge.configure(reactApplicationContext, apiKey, endpoint, platform)
    }

    @ReactMethod
    fun identify(tag: String?, submit: Boolean, promise: Promise) {
        BadeleBridge.identify(tag, submit, settle(promise))
    }

    @ReactMethod
    fun collect(promise: Promise) {
        BadeleBridge.collect(settle(promise))
    }

    /**
     * Resolve or reject, once.
     *
     * The rejection code is the HTTP status where there was one, as a string,
     * so a caller can branch on 401 (the key is wrong) or 402 (the organisation
     * is not accepting traffic) without parsing a message. Both are the
     * customer's configuration rather than the user's behaviour, and an app
     * that retries either is an app that drains a battery over a typo.
     */
    private fun settle(promise: Promise): BridgeCallback = object : BridgeCallback {
        override fun onSuccess(json: String) {
            promise.resolve(json)
        }

        override fun onError(code: String, message: String) {
            promise.reject(code, message)
        }
    }
}
