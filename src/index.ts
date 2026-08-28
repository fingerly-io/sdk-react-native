/**
 * @badele/react-native — the React Native SDK.
 *
 * # This package collects nothing
 *
 * That is the design, not a limitation. Every signal worth having on a phone is
 * unreachable from JavaScript: `lstat` on `/var/jb`, the dyld image list, the
 * thread names Frida leaves behind, the `P_TRACED` flag, the DeviceCheck token
 * Apple signs, the TLS chain the app was actually served. A React Native bridge
 * can reach none of them.
 *
 * So an SDK that collected what it *could* reach from JavaScript would report a
 * jailbroken, instrumented device as clean — which is worse than reporting
 * nothing, because a customer would believe it. This package calls the native
 * SDK and hands back what it produced.
 *
 * The consequence worth stating: the detection logic lives in one place per
 * platform, in Swift and in Kotlin, and improving it improves React Native,
 * Flutter and native apps at the same time rather than three times over.
 *
 * ```ts
 * import { load } from '@badele/react-native'
 *
 * const badele = await load({ apiKey: 'pk_live_…' })
 * const { requestId, verdicts } = await badele.identify({ tag: 'checkout' })
 *
 * if (verdicts.jailbreak.value && verdicts.jailbreak.confidence === 'high') {
 *   // step up to a challenge
 * }
 * ```
 */

import { NativeModules, Platform } from 'react-native'

import type {
  MobileVerdicts,
  NativeIdentifyResult,
  SdkPlatform,
  SignalReport,
  Verdict,
} from '@badele/core'

/**
 * The native module, as the bridge exposes it.
 *
 * Both methods answer with a JSON string rather than an object. React Native's
 * bridge serialises through a small set of types and Flutter's method channel
 * has its own codec, so marshalling the report into either by hand would mean
 * another mapping to keep in step with the wire format — and the wire format is
 * already JSON.
 */
interface BadeleNativeModule {
  configure(apiKey: string, endpoint: string, platform: string): void
  identify(tag: string | null, submit: boolean): Promise<string>
  collect(): Promise<string>
  readonly sdkVersion: string
}

/**
 * The native module, looked up on every call rather than captured at import.
 *
 * Capturing it once at module scope is the obvious spelling and it is wrong
 * under the New Architecture, where modules are registered lazily: an SDK
 * imported before its module was registered would hold `undefined` for the
 * lifetime of the app and report "run pod install" to somebody who had. One
 * property lookup per identification is not a cost worth that failure mode.
 */
function nativeModule(): BadeleNativeModule | undefined {
  return NativeModules.Badele as BadeleNativeModule | undefined
}

/**
 * The message shown when the native module is missing.
 *
 * Worth being specific about, because this is the failure every React Native
 * integration hits first and "undefined is not an object" tells nobody what to
 * do about it. The cause is almost always a pod install that has not been run
 * or an app that was not rebuilt after adding the dependency — autolinking
 * handles the rest.
 */
const MISSING_NATIVE_MODULE =
  '@badele/react-native could not find its native module. ' +
  'Run `pod install` in ios/ and rebuild the app — this package cannot ' +
  'collect anything without it, and collecting a subset from JavaScript would ' +
  'report a compromised device as clean.'

export interface BadeleOptions {
  /** The SDK key, from the dashboard. */
  apiKey: string
  /** Origin of the API. Defaults to production. */
  endpoint?: string
}

export interface IdentifyOptions {
  /** Echoed back on the finished event, for the caller's own correlation. */
  tag?: string
  /**
   * Collect and score without sending anything.
   *
   * `requestId` comes back empty, which is the honest answer: nothing was
   * submitted, so there is nothing to fetch later.
   */
  submit?: boolean
}

/**
 * Which platform this SDK reports as.
 *
 * The host is named as well as the toolkit — `react-native-ios`, not
 * `react-native` — because the server maps an SDK platform onto one of three
 * scoring profiles by looking for `ios` or `android` in the string, and a
 * React Native app that does not say which one it is running on is scored
 * against browser weights, where `jailbreak` is not a signal at all.
 *
 * See `models.RiskPlatformFor` on the server.
 */
function platformName(): SdkPlatform {
  return Platform.OS === 'android' ? 'react-native-android' : 'react-native-ios'
}

/**
 * A verdict with nothing behind it.
 *
 * The convention the whole codebase uses for "this could not be asked": false,
 * with an empty `reasons`. Distinct from a verdict of false, which has reasons.
 */
const UNKNOWN_VERDICT: Verdict = { value: false, confidence: 'low', reasons: [] }

/**
 * Fill in the verdicts this platform's SDK does not produce.
 *
 * The iOS SDK emits `jailbreak` and `simulator` and knows nothing of `root`;
 * Android is the mirror image. `MobileVerdicts` declares all of them, so the
 * type would be a lie if this did not make it true — and a lie of exactly the
 * worst kind, because `verdicts.root.value` would throw on iOS at runtime while
 * typechecking cleanly.
 *
 * Filling rather than narrowing is the trade [[MobileVerdicts]] documents: the
 * absent members come back as [[UNKNOWN_VERDICT]], which is the same thing
 * every detector in this codebase returns when its inputs are missing.
 */
function normalizeVerdicts(raw: Partial<MobileVerdicts> | undefined): MobileVerdicts {
  return {
    instrumentation: raw?.instrumentation ?? UNKNOWN_VERDICT,
    mitm: raw?.mitm ?? UNKNOWN_VERDICT,
    automation: raw?.automation ?? UNKNOWN_VERDICT,
    tampering: raw?.tampering ?? UNKNOWN_VERDICT,
    farm: raw?.farm ?? UNKNOWN_VERDICT,
    jailbreak: raw?.jailbreak ?? UNKNOWN_VERDICT,
    simulator: raw?.simulator ?? UNKNOWN_VERDICT,
    root: raw?.root ?? UNKNOWN_VERDICT,
    emulator: raw?.emulator ?? UNKNOWN_VERDICT,
    appCloner: raw?.appCloner ?? UNKNOWN_VERDICT,
  }
}

export class BadeleClient {
  /**
   * Collect, score locally, and submit.
   *
   * Returns as soon as the server has a receipt. It does not wait for the
   * enriched event — IP geolocation and the velocity windows take far longer
   * than a screen should block for — so this answers with a `requestId` that
   * the finished event is fetched by.
   */
  async identify(options: IdentifyOptions = {}): Promise<NativeIdentifyResult> {
    const native = nativeModule()
    if (!native) throw new Error(MISSING_NATIVE_MODULE)

    const raw = await native.identify(options.tag ?? null, options.submit !== false)
    const parsed = JSON.parse(raw) as NativeIdentifyResult

    return { ...parsed, verdicts: normalizeVerdicts(parsed.verdicts) }
  }

  /**
   * Run the sources and assemble the report, without submitting.
   *
   * Useful on its own: a debug screen, or a customer who wants to see exactly
   * what would be sent before they agree to send it.
   */
  async collect(): Promise<SignalReport> {
    const native = nativeModule()
    if (!native) throw new Error(MISSING_NATIVE_MODULE)

    const raw = await native.collect()
    return JSON.parse(raw) as SignalReport
  }
}

/**
 * A configured client.
 *
 * Async, and it returns a promise even though the native `configure` is
 * synchronous. That is deliberate and matches every other Badele SDK: the shape
 * callers write today is the shape that still works when this needs to await
 * something, and changing `load` from sync to async later would break every
 * integration at once.
 */
export async function load(options: BadeleOptions): Promise<BadeleClient> {
  const native = nativeModule()
  if (!native) throw new Error(MISSING_NATIVE_MODULE)

  native.configure(options.apiKey, options.endpoint ?? '', platformName())
  return new BadeleClient()
}

/** The native SDK's version, which is the one that did the collecting. */
export function nativeVersion(): string | undefined {
  return nativeModule()?.sdkVersion
}

// Re-exported so an app that only installs @badele/react-native can name the
// types it receives without also depending on the kernel directly. They are the
// same types the browser SDK returns, from the same package — which is the
// point of the report envelope being shared.
export type {
  AndroidVerdicts,
  Confidence,
  IntegrityReport,
  IosVerdicts,
  Lie,
  MobileVerdicts,
  NativeIdentifyResult,
  NativeVerdicts,
  SdkPlatform,
  SignalOutcome,
  SignalReport,
  SignalStatus,
  Verdict,
} from '@badele/core'
