/**
 * @fingerly/react-native — the React Native SDK.
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
 * import { load } from '@fingerly/react-native'
 *
 * const fingerly = await load({ apiKey: 'fly_pk_production_…' })
 * const { requestId, verdicts } = await fingerly.identify({ tag: 'checkout' })
 *
 * if (verdicts.jailbreak.value && verdicts.jailbreak.confidence === 'high') {
 *   // step up to a challenge
 * }
 * ```
 */

import { NativeModules, Platform } from 'react-native'

import type {
  MobileFingerlyOptions,
  MobileIdentifyOptions,
  MobileVerdicts,
  NativeIdentifyResult,
  SdkPlatform,
  SignalReport,
  Verdict,
} from '@fingerly/types'

/**
 * The native module, as the bridge exposes it.
 *
 * Both methods answer with a JSON string rather than an object. React Native's
 * bridge serialises through a small set of types and Flutter's method channel
 * has its own codec, so marshalling the report into either by hand would mean
 * another mapping to keep in step with the wire format — and the wire format is
 * already JSON.
 */
interface FingerlyNativeModule {
  configure(apiKey: string, endpoint: string, platform: string, consent: ConsentState): void
  setConsent(state: ConsentState): void
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
function nativeModule(): FingerlyNativeModule | undefined {
  return NativeModules.Fingerly as FingerlyNativeModule | undefined
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
  '@fingerly/react-native could not find its native module. ' +
  'Run `pod install` in ios/ when building for iOS, then rebuild the native ' +
  'app — this package cannot ' +
  'collect anything without it, and collecting a subset from JavaScript would ' +
  'report a compromised device as clean.'

/**
 * Whether the user has agreed to be identified.
 *
 * The same three states, spelled the same way, as `@fingerly/core` and the
 * native SDKs. Declared here rather than taken from `@fingerly/types` so this
 * bridge builds against any copy of the shared types, including one that
 * predates consent.
 */
export type ConsentState = 'granted' | 'pending' | 'denied'

export interface FingerlyOptions extends MobileFingerlyOptions {
  /**
   * The consent to start from. `granted` when omitted, which is how every
   * integration written before this option behaves.
   *
   * An app whose legal basis for identifying users is consent passes
   * `pending` and calls [[FingerlyClient.setConsent]] once its consent tool
   * has an answer. Until then `identify()` and `collect()` reject with a
   * [[ConsentError]] and the native SDK runs no source and sends nothing.
   */
  consent?: ConsentState
}

export type IdentifyOptions = MobileIdentifyOptions

/** A native or transport failure surfaced consistently on both platforms. */
export class FingerlyError extends Error {
  // Widened to `string` so a subclass can name itself.
  override readonly name: string = 'FingerlyError'

  constructor(
    message: string,
    /** The HTTP status when the failure came from a server response. */
    readonly status?: number,
  ) {
    super(message)
  }
}

/**
 * The call was refused because consent is not `granted`.
 *
 * Nothing was collected and nothing was sent: the native SDK refuses before
 * its first source runs, and a call already in flight when consent is
 * withdrawn refuses before it submits. `code` is the string every Fingerly SDK
 * and bridge uses for this failure, so a handler shared with the browser SDK
 * can branch on it without an `instanceof`.
 *
 * A `FingerlyError` as well, so a handler that already catches those keeps
 * catching everything this package throws.
 */
export class ConsentError extends FingerlyError {
  override readonly name: string = 'ConsentError'
  readonly code = 'consent_required'

  constructor(readonly state: ConsentState) {
    super(`Fingerly needs consent before it can identify this visitor (consent is ${state})`)
  }
}

const CONSENT_REQUIRED = 'consent_required'

const CONSENT_STATES: readonly ConsentState[] = ['granted', 'pending', 'denied']

function isConsentState(value: unknown): value is ConsentState {
  return CONSENT_STATES.includes(value as ConsentState)
}

/**
 * Refuse anything that is not one of the three states.
 *
 * Loud, as the browser SDK is. Consent tools hand over booleans, `'accepted'`
 * and `'all'`, and the native SDKs would read any of those as `pending`: safe,
 * but an app that stopped identifying anybody without saying why.
 */
function assertConsentState(state: unknown): asserts state is ConsentState {
  if (!isConsentState(state)) {
    throw new TypeError(
      `Fingerly consent must be 'granted', 'pending' or 'denied' (received ${JSON.stringify(state)})`,
    )
  }
}

/**
 * The state behind a native `consent_required` rejection.
 *
 * The iOS bridge carries it in `userInfo.state`. The Android bridge reports a
 * code and a message only, and the message ends with the state in a fixed
 * form. Anything unreadable is `pending`, which is what the native SDKs read
 * an unknown state as.
 */
function refusedConsent(record: Record<string, unknown> | undefined, message: string): ConsentState {
  const userInfo = record?.userInfo
  const fromUserInfo =
    typeof userInfo === 'object' && userInfo !== null
      ? (userInfo as Record<string, unknown>).state
      : undefined
  if (isConsentState(fromUserInfo)) return fromUserInfo

  const fromMessage = /\(consent is (\w+)\)/.exec(message)?.[1]
  return isConsentState(fromMessage) ? fromMessage : 'pending'
}

/**
 * The consent this package last handed to the native SDK.
 *
 * Module state rather than a field on the client, because the native bridge
 * keeps one client per process: every `FingerlyClient` here talks to it, and a
 * second `load` changes the state for all of them.
 */
let currentConsent: ConsentState = 'granted'

function fingerlyError(error: unknown): FingerlyError {
  if (error instanceof FingerlyError) return error

  const record =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)
      : undefined
  const code = record?.code
  const message =
    error instanceof Error
      ? error.message
      : typeof record?.message === 'string'
        ? record.message
        : String(error)

  if (code === CONSENT_REQUIRED) return new ConsentError(refusedConsent(record, message))

  const parsedStatus =
    typeof code === 'number'
      ? code
      : typeof code === 'string' && code.trim() !== ''
        ? Number(code)
        : undefined
  const status =
    typeof parsedStatus === 'number' && Number.isInteger(parsedStatus) && parsedStatus > 0
      ? parsedStatus
      : undefined

  return new FingerlyError(message, status)
}

async function invokeNative(operation: () => Promise<string>): Promise<string> {
  try {
    return await operation()
  } catch (error) {
    throw fingerlyError(error)
  }
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

export class FingerlyClient {
  /**
   * The consent last given to the native SDK, by [[load]] or [[setConsent]].
   *
   * Read-only; change it with [[setConsent]].
   */
  get consent(): ConsentState {
    return currentConsent
  }

  /**
   * Record the user's answer, as the consent tool reports it.
   *
   * Synchronous and safe to repeat. It applies to the next call and to any
   * call already in flight: withdrawing consent stops a running `identify()`
   * before it starts another source or submits, and that call rejects with a
   * [[ConsentError]]. Throws a `TypeError` for anything that is not one of the
   * three states rather than guessing what a consent tool meant.
   */
  setConsent(state: ConsentState): void {
    assertConsentState(state)
    const native = nativeModule()
    if (!native) throw new FingerlyError(MISSING_NATIVE_MODULE)

    try {
      native.setConsent(state)
    } catch (error) {
      throw fingerlyError(error)
    }
    currentConsent = state
  }

  /**
   * Collect, score locally, and submit.
   *
   * Returns the server's verdict, not a receipt for one. There is no second
   * call to make: the address lookup and the scoring happen on the request, so
   * `suspectScore` and `visitorId` are populated by the time this resolves.
   *
   * `suspectScore` is `null` rather than `0` when nothing scored the
   * submission. The two are different answers — `0` means "scored, nothing
   * fired" — and the native bridges send an explicit null to keep them apart.
   *
   * Rejects with a [[ConsentError]] while consent is not `granted`.
   */
  async identify(options: IdentifyOptions = {}): Promise<NativeIdentifyResult> {
    const native = nativeModule()
    if (!native) throw new FingerlyError(MISSING_NATIVE_MODULE)

    const raw = await invokeNative(() =>
      native.identify(options.tag ?? null, options.submit !== false),
    )
    const parsed = JSON.parse(raw) as NativeIdentifyResult

    return { ...parsed, verdicts: normalizeVerdicts(parsed.verdicts) }
  }

  /**
   * Run the sources and assemble the report, without submitting.
   *
   * Useful on its own: a debug screen, or a customer who wants to see exactly
   * what would be sent before they agree to send it. Collecting still needs
   * consent, and rejects with a [[ConsentError]] without it.
   */
  async collect(): Promise<SignalReport> {
    const native = nativeModule()
    if (!native) throw new FingerlyError(MISSING_NATIVE_MODULE)

    const raw = await invokeNative(() => native.collect())
    return JSON.parse(raw) as SignalReport
  }
}

/**
 * A configured client.
 *
 * Async, and it returns a promise even though the native `configure` is
 * synchronous. That is deliberate and matches every other Fingerly SDK: the shape
 * callers write today is the shape that still works when this needs to await
 * something, and changing `load` from sync to async later would break every
 * integration at once.
 *
 * Loading collects and sends nothing, whatever the consent, so it is safe to
 * call at launch before the user has been asked. The consent passed here, or
 * `granted` when there is none, replaces whatever the native SDK held before.
 */
export async function load(options: FingerlyOptions): Promise<FingerlyClient> {
  const consent = options.consent ?? 'granted'
  assertConsentState(consent)

  const native = nativeModule()
  if (!native) throw new FingerlyError(MISSING_NATIVE_MODULE)

  try {
    native.configure(options.apiKey, options.endpoint ?? '', platformName(), consent)
  } catch (error) {
    throw fingerlyError(error)
  }
  currentConsent = consent
  return new FingerlyClient()
}

/** The native SDK's version, which is the one that did the collecting. */
export function nativeVersion(): string | undefined {
  return nativeModule()?.sdkVersion
}

// Re-exported so an app that only installs @fingerly/react-native can name the
// types it receives without also depending on the kernel directly. They are the
// same types the browser SDK returns, from the same package — which is the
// point of the report envelope being shared.
export type {
  AndroidVerdicts,
  Confidence,
  IdentifyTrigger,
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
} from '@fingerly/types'
