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
 * The consequence worth stating: the collection logic lives in one place per
 * platform, in Swift and in Kotlin, and improving it improves React Native,
 * Flutter and native apps at the same time rather than three times over. What
 * the signals mean is decided on the server, and nothing here reaches a
 * conclusion of its own.
 *
 * ```ts
 * import { load } from '@fingerly/react-native'
 *
 * const fingerly = await load({ apiKey: 'fly_pk_production_…' })
 * // From the consent tool, once the user has agreed (or another lawful basis applies).
 * fingerly.setConsent('granted')
 * const { requestId } = await fingerly.identify({ tag: 'checkout' })
 *
 * // Send requestId to your backend and make the decision there.
 * ```
 */

import { NativeModules, Platform } from 'react-native'

import type {
  MobileFingerlyOptions,
  MobileIdentifyOptions,
  NativeIdentifyResult,
  SdkPlatform,
  SignalReport,
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
  identify(tag: string | null, submit: boolean, automatic: boolean): Promise<string>
  collect(): Promise<string>
  /** Optional because a native module built before it existed does not have it. */
  deleteStoredIdentity?(): Promise<null>
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
   * The consent to start from. `pending` when omitted.
   *
   * Leave it `pending` and call [[FingerlyClient.setConsent]] once the app's
   * consent tool has an answer. Until consent is `granted`, `identify()` and
   * `collect()` reject with a [[ConsentError]] and the native SDK runs no
   * source and sends nothing. Pass `granted` only once the user has agreed, or
   * where another lawful basis applies.
   */
  consent?: ConsentState
}

export interface IdentifyOptions extends MobileIdentifyOptions {
  /**
   * True for a call the app makes on its own rather than in answer to the
   * user: on start, on a timer, on returning to the foreground. An automatic
   * call joins an identification already in flight instead of starting
   * another, and waits out a transient failure instead of repeating it at
   * once. False when omitted. On Android it has no effect until the native
   * Android SDK supports it.
   */
  automatic?: boolean
}

/**
 * What `identify({ submit: false })` resolves with. Nothing was sent, so nobody
 * answered, and the raw report is all there is.
 */
export interface RawReportResult {
  report: SignalReport
}

/** A native or transport failure surfaced consistently on both platforms. */
export class FingerlyError extends Error {
  // Widened to `string` so a subclass can name itself.
  override readonly name: string = 'FingerlyError'

  constructor(
    message: string,
    /** The HTTP status when the failure came from a server response. */
    readonly status?: number,
    /**
     * How long the server asked the app to wait, in milliseconds, from its
     * `Retry-After`, when the native SDK gave up on a 429 or 503 that named
     * one. Wait at least this long before identifying again. Undefined when
     * the response named no wait, and on Android until the native Android
     * bridge passes the header on.
     */
    readonly retryAfterMs?: number,
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
let currentConsent: ConsentState = 'pending'

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

  return new FingerlyError(message, status, retryAfterOf(record))
}

/**
 * The wait a native transport failure carried. The iOS bridge puts it in the
 * NSError's `userInfo.retryAfterMs`, which React Native passes through as the
 * rejection's `userInfo`.
 */
function retryAfterOf(record: Record<string, unknown> | undefined): number | undefined {
  const userInfo = record?.userInfo
  const wait =
    typeof userInfo === 'object' && userInfo !== null
      ? (userInfo as Record<string, unknown>).retryAfterMs
      : undefined
  return typeof wait === 'number' && Number.isFinite(wait) && wait >= 0 ? wait : undefined
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
 * The native JSON as an object, or a `FingerlyError`.
 *
 * A `SyntaxError`, or a `TypeError` from spreading `null`, would escape a
 * handler that checks `instanceof FingerlyError`, which is the one every
 * caller writes.
 */
function parseNative(raw: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new FingerlyError('The SDK produced an unreadable report')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new FingerlyError('The SDK produced an unreadable report')
  }
  return parsed as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Named rather than spread, so what reaches the app is what the server said and
// nothing else: a signal name or a conclusion from an older native build is
// left behind here even if the native side still sends one.
const SERVER_FIELDS = [
  'requestId',
  'visitorId',
  'visitorIsNew',
  'visitorConfidence',
  'identifiable',
  'duplicate',
  'state',
  'reason',
  'suspectScore',
  'suspectLevel',
  'report',
] as const

function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const field of fields) {
    // An explicit null survives: an unscored check is null, not absent and not 0.
    if (source[field] !== undefined) picked[field] = source[field]
  }
  return picked
}

// A native build may write null or leave the key out. The types promise null,
// so an answer the server did not give reads the same on both platforms: never
// undefined, and never an invented 0 or false.
const NULLABLE_FIELDS = [
  'visitorIsNew',
  'visitorConfidence',
  'identifiable',
  'duplicate',
  'suspectScore',
  'suspectLevel',
] as const

function serverAnswer(parsed: Record<string, unknown>): NativeIdentifyResult {
  const answer = pick(parsed, SERVER_FIELDS)
  for (const field of NULLABLE_FIELDS) {
    if (answer[field] === undefined) answer[field] = null
  }
  return answer as unknown as NativeIdentifyResult
}

function rawReport(parsed: Record<string, unknown>): RawReportResult {
  if (!isRecord(parsed.report)) throw new FingerlyError('The SDK produced an unreadable report')
  return { report: parsed.report as unknown as SignalReport }
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
   * Collect and submit.
   *
   * Returns the server's answer, not a receipt for one. There is no second
   * call to make: the address lookup and the scoring happen on the request, so
   * `suspectScore` and `visitorId` are populated by the time this resolves.
   *
   * `suspectScore` is `null` rather than `0` when nothing scored the
   * submission or the key hides the score from apps. The two are different
   * answers — `0` means "scored, nothing fired" — and the native bridges send
   * an explicit null to keep them apart.
   *
   * With `submit: false` nothing is sent and only the raw report comes back.
   *
   * Rejects with a [[ConsentError]] while consent is not `granted`.
   */
  identify(options: IdentifyOptions & { submit: false }): Promise<RawReportResult>
  identify(options?: IdentifyOptions & { submit?: true }): Promise<NativeIdentifyResult>
  identify(options: IdentifyOptions): Promise<NativeIdentifyResult | RawReportResult>
  async identify(options: IdentifyOptions = {}): Promise<NativeIdentifyResult | RawReportResult> {
    const native = nativeModule()
    if (!native) throw new FingerlyError(MISSING_NATIVE_MODULE)

    const raw = await invokeNative(() =>
      native.identify(options.tag ?? null, options.submit !== false, options.automatic === true),
    )
    const parsed = parseNative(raw)

    return options.submit === false ? rawReport(parsed) : serverAnswer(parsed)
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
    return parseNative(raw) as unknown as SignalReport
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
 * `pending` when there is none, replaces whatever the native SDK held before.
 */
export async function load(options: FingerlyOptions): Promise<FingerlyClient> {
  const consent = options.consent ?? 'pending'
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

/**
 * Delete the install record the native SDK keeps on the device.
 *
 * Call it when a user asks for their data to be erased or deletes their
 * account, so the device stops presenting the install ID the server knows it
 * by. Needs no [[load]] and no consent, and sends nothing. Resolves once no
 * record remains, including when there was none. The next identification made
 * with consent starts a new record; to stop identifying as well, set consent
 * to `'denied'` first, because a call already running may write a fresh record.
 *
 * Rejects with a [[FingerlyError]] when the delete fails, and when the native
 * SDK in the app predates this call.
 */
export async function deleteStoredIdentity(): Promise<void> {
  const native = nativeModule()
  if (!native) throw new FingerlyError(MISSING_NATIVE_MODULE)

  const remove = native.deleteStoredIdentity
  if (typeof remove !== 'function') {
    throw new FingerlyError(
      `deleteStoredIdentity is not available in the native Fingerly SDK on ${Platform.OS}`,
    )
  }

  try {
    await remove.call(native)
  } catch (error) {
    throw fingerlyError(error)
  }
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
  IntegrityReport,
  Lie,
  NativeIdentifyResult,
  SdkPlatform,
  SignalOutcome,
  SignalReport,
  SignalStatus,
} from '@fingerly/types'
