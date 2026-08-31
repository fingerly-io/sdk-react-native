# @badele/react-native

React Native bindings for Badele. A bridge to the native iOS and Android SDKs,
which do the collecting.

```
pnpm add @badele/react-native
cd ios && pod install
```

Requires React Native **0.73** or newer. Autolinking handles the rest.

## Identify

```ts
import { load } from '@badele/react-native'

const badele = await load({ apiKey: 'pk_live_…' })
const { requestId, visitorId, suspectScore, verdicts } = await badele.identify({ tag: 'checkout' })

if (verdicts.jailbreak.value && verdicts.jailbreak.confidence === 'high') {
  // step up to a challenge, hold for review, add friction
}
```

The key is a **publishable** SDK key from the dashboard, and it is safe in a
shipped bundle — it is scoped to the app identifiers you list. A **secret** key
is refused when it arrives from a client, so pasting one in does not work by
design.

`identify()` collects, scores on the device, and submits. It resolves with the
server's verdict — `visitorId`, `suspectScore`, `suspectLevel` and the triggers
behind them — so there is no second call to make. Send the `requestId` and
`visitorId` to your own backend with the request they belong to, and let your
backend decide: **the score in your hand came from a device you do not
control**, and an app that branches on it locally is an app whose branch can be
patched out.

Pass `{ submit: false }` to collect and score without sending anything.

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

This package calls the native SDK and hands back what it produced. The detection
logic lives in one place per platform, in Swift and in Kotlin, and improving it
improves React Native, Flutter and native apps at the same time rather than
three times over.

If the native module is missing, `load()` throws and says so. It does not
degrade to a JavaScript-only mode, for the reason above.

## The verdicts

The same objects the native SDKs return, with the platform-specific members
present on the platform that can answer them:

```ts
interface NativeVerdicts {
  instrumentation: Verdict  // Frida, Substrate, Substitute, ElleKit
  mitm: Verdict             // something intercepting the app's TLS
  automation: Verdict       // a debugger or a UI-test runner driving it
  tampering: Verdict        // hooked functions, injected images
  farm: Verdict             // mass-provisioned or reset-fresh
}

interface IosVerdicts extends NativeVerdicts {
  jailbreak: Verdict
  simulator: Verdict
}

interface AndroidVerdicts extends NativeVerdicts {
  root: Verdict
  emulator: Verdict
  appCloner: Verdict
}
```

Each carries `value`, `confidence` and `reasons` — strongest first:

```ts
if (verdicts.instrumentation.value) {
  console.warn(verdicts.instrumentation.reasons)
  // → ['instrumentation-image-libhooker.dylib', 'instrumentation-thread-gum-js-loop']
}
```

These are advice. The same rules run again on the server, over the stored
report, where they can improve without every customer shipping an app update —
which on mobile is the difference between a fix landing this week and landing
over the next eighteen months. **The decision belongs on your server.**

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
const report = await badele.collect()   // no submission

for (const [id, outcome] of Object.entries(report.sources)) {
  console.log(id, outcome.status, `${outcome.ms}ms`, outcome.reason ?? '')
}
```

Five statuses, never a hole: `ok`, `unsupported`, `blocked`, `timeout`, `error`.
The distinction matters — a `blocked` jailbreak probe is stronger evidence than
any value it could have returned, because `lstat` on a path does not fail unless
something made it.

## Errors

`identify()` rejects with an `Error` whose `message` is the server's, for the
two cases worth branching on:

- **401** — the key is wrong, or was presented from an app identifier it does
  not list.
- **402** — the organisation is not accepting traffic.

Both are your configuration rather than the user's behaviour, and neither is
worth retrying. The native SDK retries the ones that are (429 and 5xx) with
full-jitter backoff before it ever rejects.

## Status

Both platforms are implemented. `ios/BadeleModule.swift` calls
[`mobile/ios`](../ios) and `android/…/BadeleModule.kt` calls
[`mobile/android`](../android); each is a few dozen lines of forwarding to that
SDK's `BadeleBridge`, with no logic of its own by design.

Neither has been compiled here — a React Native module needs `React-Core` and
`com.facebook.react:react-android` on the compile path, and no host app is
installed on the machine this was written on. What they call is compiled and
tested by each native SDK's own suite.

The Android module depends on `io.badele:badele:0.1.0`, which is not published
yet. Until it is, build the SDK's AAR into your local Maven repository:

```
cd ../android && ./gradlew :badele:publishToMavenLocal
```

and add `mavenLocal()` to the host app's repositories.

## Development

```
pnpm build
pnpm test
```

The tests run against a stub for `react-native` rather than the real package —
pulling the React Native tree in to unit-test a thirty-line bridge would be a
hundred megabytes of install for nothing. See `tests/stub-react-native.ts`.
