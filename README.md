# @fingerly/react-native

React Native bindings for Fingerly. A bridge to the native iOS and Android SDKs,
which do the collecting.

```
pnpm add @fingerly/react-native
cd ios && pod install
```

Requires React Native **0.73** or newer. Autolinking handles the rest.

## Identify

```ts
import { load } from '@fingerly/react-native'

// consent: only once you have consent (or another lawful basis)
const fingerly = await load({ apiKey: 'fly_pk_production_…', consent: 'granted' })
const { requestId, visitorId, suspectScore, suspectLevel } = await fingerly.identify({ tag: 'checkout' })

// Send requestId to your backend and make the decision there.
```

The key is a **publishable** SDK key from the dashboard, and it is safe in a
shipped bundle — it is scoped to the app identifiers you list. A **secret** key
is refused when it arrives from a client, so pasting one in does not work by
design.

`identify()` collects and submits. It resolves with what the server said:
`requestId`, `visitorId` and, by default, `suspectScore` and `suspectLevel`, so
there is no second call to make. The score is a convenience for showing a result
straight away. Each SDK key has a setting that hides it from apps, and then both
fields are `null`, exactly as on a check nobody scored: an app cannot tell which
it was, so read `null` as "no answer here", never as clean. The signals behind a
score never reach the device; read them on your backend, through the server-side
event read by `requestId` or webhooks, or in the dashboard.
`visitorConfidence`, `visitorIsNew`,
`identifiable` and `duplicate` can be `null` when the server did not say, which
is not the same as `0` or `false`. Send the `requestId` and
`visitorId` to your own backend with the request they belong to, and let your
backend decide: **the score in your hand came from a device you do not
control**, and an app that branches on it locally is an app whose branch can be
patched out.

Pass `{ submit: false }` to collect without sending anything. It resolves with
`{ report }`, the raw report and nothing else.

Pass `{ automatic: true }` for a call your app makes on its own rather than in
answer to the user: on start, on a timer, on returning to the foreground. It
joins an identification already in flight instead of starting another, and
waits out a transient failure instead of repeating it at once. On Android it
has no effect until the native Android SDK supports it.

## Consent

The SDK identifies nobody until it is told consent is `'granted'`. The usual
pattern is to load it at launch with the default `'pending'` and pass on the
answer from your consent tool when it arrives:

```ts
import { ConsentError, load } from '@fingerly/react-native'

const fingerly = await load({ apiKey: 'fly_pk_production_…' }) // consent is 'pending'

// From your consent tool's callback:
fingerly.setConsent(accepted ? 'granted' : 'denied')

fingerly.consent   // 'granted', 'pending' or 'denied'
```

| Option / method | What it does |
| --- | --- |
| `consent` option on `load` | The starting state: `'pending'` (the default), `'granted'` or `'denied'`. |
| `setConsent(state)` | Records the decision. Synchronous and safe to call repeatedly. |
| `consent` | The state last given to the native SDK, read-only. |

The default is `'pending'`, so an integration that never mentions consent
identifies nobody. Pass `consent: 'granted'` to `load` only when you already
have consent, or another lawful basis. Anything other than the three states
throws a `TypeError` rather than being guessed at.

While the state is anything but `granted`, the native SDK runs no source,
reads and writes no keychain entry or preference for fingerprinting, and sends
nothing.
`identify()` and `collect()` reject with a `ConsentError`, whose `code` is
`'consent_required'` and whose `state` says which state refused the call:

```ts
try {
  await fingerly.identify()
} catch (error) {
  if (error instanceof ConsentError) {
    // error.state is 'pending' or 'denied'; nothing was collected or sent
  }
}
```

A change applies to calls already in flight as well as later ones. Consent
withdrawn halfway through an `identify()` stops it before the next source
starts and before anything is submitted, and that call rejects with
`ConsentError`.

Loading collects and sends nothing, whatever the state, so calling `load` at
launch before the user has been asked is safe. The native SDK holds one state
for the whole app: each `load` sets it to the `consent` passed, or `'pending'`
when there is none, so pass `consent` on every `load`.

Every submission the native SDK sends carries the state it was collected under,
`"consent": "granted"`, and the server refuses any other value with
`422 consent_required`. The native SDK only sends while consent is granted, so
that refusal should never be seen.

## Erasure

```ts
import { deleteStoredIdentity } from '@fingerly/react-native'

await deleteStoredIdentity()
```

Deletes the install record the native SDK keeps on the device, including the
install ID the server recognises it by. Call it when a user asks for their data
to be erased or deletes their account. It needs no `load` and no consent, and
sends nothing, and resolves once no record remains, including when there was
none. It rejects with a `FingerlyError` when the delete fails. The next
identification made with consent starts a new record; to stop identifying as
well, set consent to `'denied'` first.

## This package collects nothing

That is the design, not a limitation, and it is the most important thing to
understand about it.

Every signal worth having on a phone is unreachable from JavaScript: `lstat` on
`/var/jb`, the dyld image list, the thread names Frida's runtime leaves behind,
the `P_TRACED` flag, the DeviceCheck token Apple's Secure Enclave signs, the TLS
chain the app was actually served. A React Native bridge can reach none of them.

So a package that collected what it *could* reach from JavaScript would report a
jailbroken, instrumented device as clean — which is worse than reporting
nothing, because a customer would believe it.

This package calls the native SDK and hands back what it produced. The collection
logic lives in one place per platform, in Swift and in Kotlin, and improving it
improves React Native, Flutter, Lynx and native apps at the same time rather
than four times over. What the signals mean is decided on the server.

If the native module is missing, `load()` throws and says so. It does not
degrade to a JavaScript-only mode, for the reason above.

## The platform string

This package reports `react-native-ios` or `react-native-android`, never the
bare `react-native`. That is not cosmetic: the server maps an SDK platform onto
one of three scoring profiles by looking for `ios` or `android` in the string,
and a submission that names neither falls through to the **browser** profile —
where `jailbreak` and `simulator` are not signals at all and everything the
native SDK collected is worth zero.

Nothing fails when that goes wrong. The submission succeeds, the event is
stored, the report looks full, and the signal never fires. `tests/bridge.test.ts`
pins it for that reason.

## Reading the report

```ts
const report = await fingerly.collect()   // no submission

for (const [id, outcome] of Object.entries(report.sources)) {
  console.log(id, outcome.status, `${outcome.ms}ms`, outcome.reason ?? '')
}
```

Five statuses, never a hole: `ok`, `unsupported`, `blocked`, `timeout`, `error`.
The distinction matters — a `blocked` jailbreak probe is stronger evidence than
any value it could have returned, because `lstat` on a path does not fail unless
something made it.

## Errors

`identify()` rejects with a `FingerlyError`. Its `message` is the server's and its
`status` is the HTTP status when there was one, so callers do not have to depend
on React Native's platform-specific native error shape:

```ts
import { FingerlyError } from '@fingerly/react-native'

try {
  await fingerly.identify()
} catch (error) {
  if (error instanceof FingerlyError && error.status === 401) {
    // The SDK key or application restriction is wrong.
  }
}
```

The two configuration failures worth branching on are:

- **401** — the key is wrong, or was presented from an app identifier it does
  not list.
- **402** — the organisation is not accepting traffic.

Both are your configuration rather than the user's behaviour, and neither is
worth retrying. The native SDK retries the ones that are (429 and 5xx) with
full-jitter backoff before it ever rejects.

When the server asked for a pause with `Retry-After`, the error carries it as
`retryAfterMs`. Wait at least that long before identifying again. It is
undefined when the response named no wait, and on Android until the native
Android bridge passes the header on.

A call refused for want of consent rejects with `ConsentError`, a subclass of
`FingerlyError` with `code: 'consent_required'`, a `state`, and no `status`.
Answer it with `setConsent`, not a retry. See [Consent](#consent).

## Status

Both platforms are implemented, compiled, and exercised through a React Native
0.87 New Architecture host. `ios/FingerlyModule.swift` calls the
[iOS SDK](https://github.com/fingerly-io/sdk-ios) and
`android/…/FingerlyModule.kt` calls the Android SDK (`io.fingerly:fingerly`); each is a few dozen
lines of forwarding to that SDK's `FingerlyBridge`, with no logic of its own by
design.

The iOS bridge builds through CocoaPods and ran on an iPhone 16e simulator: all
21 sources completed in 163ms cold and 105ms warm, with 59ms and 3ms of bridge
overhead respectively. The Android bridge builds into a debug APK and ran on an
API 36 Pixel 8 emulator: all 22 sources completed in 489ms cold and 61ms warm,
with 104ms and 3ms of bridge overhead respectively. Both returned native SDK
version `0.1.0` and the complete report through Hermes.

On iOS, `pod install` downloads the matching `Fingerly.xcframework` from
`https://maven.fingerly.io/ios/` and verifies its checksum, so the Podfile needs
no entry for the native SDK. The same binary is published as a Swift package at
[sdk-ios](https://github.com/fingerly-io/sdk-ios).

The Android module depends on `io.fingerly:fingerly:0.2.0` from Fingerly's Maven
repository, `https://maven.fingerly.io`, which the bridge adds to the build
itself, so the host app needs no repository override. The bridge checks Maven
Local before Fingerly's repository.

**Installed-app checks are opt-in on Android.** From the Android SDK release
after 0.1.0, the checks for root managers, hooking frameworks and app cloners by
package name ship in a separate artifact, `io.fingerly:fingerly-app-checks`,
because Google Play treats the list of installed apps as personal and sensitive
data. This bridge depends on `io.fingerly:fingerly` only. If your app can
justify the package visibility in its Play review and wants these checks, add
the artifact to your app's Android module, at the same version as
`io.fingerly:fingerly`, and declare "App activity: Installed apps" in the Data
safety form:

```groovy
dependencies {
    implementation 'io.fingerly:fingerly-app-checks:<same version as io.fingerly:fingerly>'
}
```

Without it, the report carries no installed-app fields and nothing about other
apps leaves the device; whether the app itself runs inside a cloner is still
reported.

**Play Integrity (Android, optional).** The Android SDK has an optional
artifact, `io.fingerly:fingerly-play-integrity` (server ADR 0026), that adds
Google Play Integrity verdicts to events. To use it, add the artifact to the
app and pass your Google Cloud project number, the one linked to the app in
Play Console, to `load`:

```groovy
// android/app/build.gradle
dependencies {
    implementation 'io.fingerly:fingerly-play-integrity:<same version as io.fingerly:fingerly>'
}
```

```ts
const fingerly = await load({
  apiKey: 'fly_pk_production_…',
  playIntegrityCloudProjectNumber: 123456789012,
})
```

The native SDK finds the artifact on its own; this bridge does not depend on
it. Without the artifact the number is ignored and nothing fails, and on iOS it
is ignored. The rest of the setup (the service account uploaded to your
Fingerly project, the daily budget) is in the Android SDK's
`fingerly-play-integrity/README.md`. This needs the Android SDK
release after 0.1.0, the first whose `FingerlyBridge.configure` takes a project
number; Gradle refuses to pair the artifact with a core of another version.

This bridge is licensed under Apache-2.0. The native SDK it depends on is a
closed binary under the Fingerly SDK License.

## Development

```
pnpm build
pnpm test
pnpm lint
```

The 30 contract tests run against a stub for `react-native` rather than the real
package — pulling the React Native tree in to unit-test a thirty-line bridge
would be a hundred megabytes of install for nothing. See
`tests/stub-react-native.ts`.

Clone this repository with `--recurse-submodules`, or run
`git submodule update --init --recursive`, so the shared `@fingerly/types`
contract is available to the standalone workspace.
