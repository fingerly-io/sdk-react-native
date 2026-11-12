<p align="center">
  <a href="https://fingerly.io">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/fingerly-io/.github/main/assets/logo-dark.svg">
      <img src="https://raw.githubusercontent.com/fingerly-io/.github/main/assets/logo-light.svg" alt="Fingerly" height="44">
    </picture>
  </a>
</p>

<p align="center"><b>Fingerly for React Native</b><br>Device intelligence and fraud signals in your React Native app, through one TypeScript API over the native iOS and Android SDKs.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@fingerly/react-native"><img src="https://img.shields.io/npm/v/@fingerly/react-native?style=flat-square" alt="npm version"></a>
  <a href="https://github.com/fingerly-io/sdk-react-native/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/fingerly-io/sdk-react-native/ci.yml?style=flat-square" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="Licence: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/react%20native-%E2%89%A50.73-blue?style=flat-square" alt="React Native 0.73 or newer">
  <a href="https://docs.fingerly.io/docs/sdks/react-native"><img src="https://img.shields.io/badge/docs-docs.fingerly.io-informational?style=flat-square" alt="Documentation"></a>
</p>

<p align="center"><img src="https://raw.githubusercontent.com/fingerly-io/.github/main/assets/banner.webp" alt="Fingerly" width="100%"></p>

## What is this

`@fingerly/react-native` is the React Native bridge to the Fingerly native iOS and Android SDKs, which do the collecting. You call `identify()` from JavaScript and get back a request ID and a visitor ID to send to your own backend, which decides what to do. [Fingerly](https://fingerly.io) is a device intelligence API that helps you protect signups, logins and payments from fraud and abuse.

## Getting started

1. **Get a key.** In the [Fingerly dashboard](https://dashboard.fingerly.io), open **Integration > SDK keys** and create a public key for your app. [How keys work](https://docs.fingerly.io/docs/api-keys).
2. **Install the package.** Autolinking handles the rest.

   ```sh
   pnpm add @fingerly/react-native
   cd ios && pod install
   ```

   Rebuild the native app afterwards. `npm install @fingerly/react-native` and `yarn add @fingerly/react-native` work as well.

3. **Identify.**

   ```ts
   import { load } from '@fingerly/react-native'

   // consent: only once you have consent (or another lawful basis)
   const fingerly = await load({ apiKey: 'fly_pk_production_…', consent: 'granted' })
   const { requestId, visitorId, suspectScore, suspectLevel } = await fingerly.identify({ tag: 'checkout' })

   // Send requestId to your backend and make the decision there.
   ```

Requires React Native **0.73** or newer.

## Contents

- [Identify](#identify)
- [Consent](#consent)
- [Erasure](#erasure)
- [Errors](#errors)
- [Reading the report](#reading-the-report)
- [Platform setup](#platform-setup)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Documentation](#documentation)
- [Development](#development)
- [Help](#help)
- [Licence](#licence)

## Identify

The key is a **publishable** SDK key from the dashboard, and it is safe in a shipped bundle: it is scoped to the app identifiers you list. A **secret** key is refused when it arrives from a client, so pasting one in does not work by design.

`identify()` collects and submits. It resolves with what the server said: `requestId`, `visitorId` and, by default, `suspectScore` and `suspectLevel`, so there is no second call to make.

- The score is a convenience for showing a result straight away. Each SDK key has a setting that hides it from apps, and then both fields are `null`, exactly as on a check nobody scored. An app cannot tell which it was, so read `null` as "no answer here", never as clean.
- The signals behind a score never reach the device. Read them on your backend, through the server-side event read by `requestId` or webhooks, or in the dashboard.
- `visitorConfidence`, `visitorIsNew`, `identifiable` and `duplicate` can be `null` when the server did not say, which is not the same as `0` or `false`.
- Send the `requestId` and `visitorId` to your own backend with the request they belong to, and let your backend decide: **the score in your hand came from a device you do not control**, and an app that branches on it locally is an app whose branch can be patched out.

| Option | What it does |
| --- | --- |
| `tag` | A string echoed back on the finished event, for your own correlation. |
| `submit: false` | Collect without sending anything. It resolves with `{ report }`, the raw report and nothing else. |
| `automatic: true` | For a call your app makes on its own rather than in answer to the user: on start, on a timer, on returning to the foreground. It joins an identification already in flight instead of starting another, and waits out a transient failure instead of repeating it at once. On Android the bridge accepts the option and ignores it. |

`nativeVersion()` returns the version of the native SDK that did the collecting.

## Consent

The SDK identifies nobody until it is told consent is `'granted'`. The usual pattern is to load it at launch with the default `'pending'` and pass on the answer from your consent tool when it arrives:

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

The default is `'pending'`, so an integration that never mentions consent identifies nobody. Pass `consent: 'granted'` to `load` only when you already have consent, or another lawful basis. Anything other than the three states throws a `TypeError` rather than being guessed at.

While the state is anything but `granted`, the native SDK runs no source, reads and writes no keychain entry or preference for fingerprinting, and sends nothing. `identify()` and `collect()` reject with a `ConsentError`, whose `code` is `'consent_required'` and whose `state` says which state refused the call:

```ts
try {
  await fingerly.identify()
} catch (error) {
  if (error instanceof ConsentError) {
    // error.state is 'pending' or 'denied'; nothing was collected or sent
  }
}
```

A change applies to calls already in flight as well as later ones. Consent withdrawn halfway through an `identify()` stops it before the next source starts and before anything is submitted, and that call rejects with `ConsentError`.

Loading collects and sends nothing, whatever the state, so calling `load` at launch before the user has been asked is safe. The native SDK holds one state for the whole app: each `load` sets it to the `consent` passed, or `'pending'` when there is none, so pass `consent` on every `load`.

Every submission the native SDK sends carries the state it was collected under, `"consent": "granted"`, and the server refuses any other value with `422 consent_required`. The native SDK only sends while consent is granted, so that refusal should never be seen.

## Erasure

```ts
import { deleteStoredIdentity } from '@fingerly/react-native'

await deleteStoredIdentity()
```

Deletes the install record the native SDK keeps on the device, including the install ID the server recognises it by. Call it when a user asks for their data to be erased or deletes their account. It needs no `load` and no consent, and sends nothing, and resolves once no record remains, including when there was none. It rejects with a `FingerlyError` when the delete fails. The next identification made with consent starts a new record; to stop identifying as well, set consent to `'denied'` first.

## Errors

`identify()` rejects with a `FingerlyError`. Its `message` is the server's and its `status` is the HTTP status when there was one, so callers do not have to depend on React Native's platform-specific native error shape:

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

- **401**: the key is wrong, or was presented from an app identifier it does not list.
- **402**: the organisation is not accepting traffic.

Both are your configuration rather than the user's behaviour, and neither is worth retrying. The native SDK retries the ones that are (429 and 5xx) with full-jitter backoff before it ever rejects.

When the server asked for a pause with `Retry-After`, the error carries it as `retryAfterMs`. Wait at least that long before identifying again. It is `undefined` when the response named no wait.

A call refused for want of consent rejects with `ConsentError`, a subclass of `FingerlyError` with `code: 'consent_required'`, a `state`, and no `status`. Answer it with `setConsent`, not a retry. See [Consent](#consent).

## Reading the report

```ts
const report = await fingerly.collect()   // no submission

for (const [id, outcome] of Object.entries(report.sources)) {
  console.log(id, outcome.status, `${outcome.ms}ms`, outcome.reason ?? '')
}
```

Five statuses, never a hole: `ok`, `unsupported`, `blocked`, `timeout`, `error`. A `blocked` outcome is information in its own right, not a missing value. `collect()` needs consent and rejects with a `ConsentError` without it.

## Platform setup

The bridge forwards to the native SDKs and adds no logic of its own. `ios/FingerlyModule.swift` calls the [iOS SDK](https://github.com/fingerly-io/sdk-ios), and `android/…/FingerlyModule.kt` calls the Android SDK (`io.fingerly:fingerly`); each is a few dozen lines of forwarding to that SDK's `FingerlyBridge`.

<details>
<summary><b>iOS</b></summary>

`pod install` downloads the matching `Fingerly.xcframework` from `https://maven.fingerly.io/ios/` and verifies its checksum, so the Podfile needs no entry for the native SDK. The same binary is published as a Swift package at [sdk-ios](https://github.com/fingerly-io/sdk-ios).

The Play Integrity project number passed to `load` is ignored on iOS.

</details>

<details>
<summary><b>Android</b></summary>

The Android module depends on `io.fingerly:fingerly:0.2.0` from Fingerly's Maven repository, `https://maven.fingerly.io`, which the bridge adds to the build itself, so the host app needs no repository override. The bridge checks Maven Local before Fingerly's repository.

**Installed-app checks are opt-in.** The checks for root managers, hooking frameworks and app cloners by package name ship in a separate artifact, `io.fingerly:fingerly-app-checks`, because Google Play treats the list of installed apps as personal and sensitive data. This bridge depends on `io.fingerly:fingerly` only. If your app can justify the package visibility in its Play review and wants these checks, add the artifact to your app's Android module, at the same version as `io.fingerly:fingerly`, and declare "App activity: Installed apps" in the Data safety form:

```groovy
dependencies {
    implementation 'io.fingerly:fingerly-app-checks:<same version as io.fingerly:fingerly>'
}
```

Without it, the report carries no installed-app fields and nothing about other apps leaves the device; whether the app itself runs inside a cloner is still reported.

**Play Integrity (optional).** The Android SDK has an optional artifact, `io.fingerly:fingerly-play-integrity`, that adds Google Play Integrity verdicts to events. To use it, add the artifact to the app and pass your Google Cloud project number, the one linked to the app in Play Console, to `load`:

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

The native SDK finds the artifact on its own; this bridge does not depend on it. Without the artifact the number is ignored and nothing fails. The rest of the setup, the service account uploaded to your Fingerly project and the daily budget, is covered by the Android SDK's [install notes](https://github.com/fingerly-io/sdk-android/blob/main/INSTALL.md#optional-play-integrity). It needs the native Android SDK version this bridge depends on or a newer one, and Gradle refuses to pair the artifact with a core of another version.

</details>

## How it works

This package collects nothing, by design. Almost everything worth collecting on a phone is out of reach of JavaScript, so a package that collected only what JavaScript can reach would report a compromised device as clean. That is worse than reporting nothing, because a customer would believe it.

The package calls the native SDK and hands back what it produced. The collection logic lives in one place per platform, in Swift and in Kotlin, so improving it improves React Native, Flutter, Lynx and native apps at the same time rather than four times over. What the signals mean is decided on the server.

If the native module is missing, `load()` throws and says so. It does not degrade to a JavaScript-only mode, for the reason above.

**The platform string.** This package reports `react-native-ios` or `react-native-android`, never the bare `react-native`. That is not cosmetic: the server relies on the platform string to apply the mobile checks. Nothing fails when it is wrong. The submission succeeds, the event is stored and the report looks full, but the mobile checks do not apply. `tests/bridge.test.ts` pins the names for that reason.

<details>
<summary><b>Where it has run</b></summary>

Both platforms are implemented, compiled, and exercised through a React Native 0.87 New Architecture host. The iOS bridge builds through CocoaPods and ran on an iPhone 16e simulator, with a cold collection of 163ms and a warm one of 105ms, and 59ms and 3ms of bridge overhead respectively. The Android bridge builds into a debug APK and ran on an API 36 Pixel 8 emulator, with a cold collection of 489ms and a warm one of 61ms, and 104ms and 3ms of bridge overhead respectively. Both returned the complete report through Hermes.

</details>

## Requirements

| | Minimum |
| --- | --- |
| React Native | 0.73 (peer dependency `react-native >=0.73`) |
| iOS | 13.0 |
| Android | 5.0 (API 21) |

## Documentation

Guides and the API reference: <https://docs.fingerly.io/docs/sdks/react-native>.

## Development

```sh
pnpm build
pnpm test
pnpm lint
```

The contract tests run against a stub for `react-native` rather than the real package: pulling the React Native tree in to unit-test a thirty-line bridge would be a hundred megabytes of install for nothing. See `tests/stub-react-native.ts`.

Clone this repository with `--recurse-submodules`, or run `git submodule update --init --recursive`, so the shared `@fingerly/types` contract is available to the standalone workspace.

## Help

Open an issue on this repository, or write to <support@fingerly.io>. Security issues: <security@fingerly.io>.

## Licence

This bridge is licensed under [Apache-2.0](LICENSE). The native SDK it depends on is a closed binary under the Fingerly SDK License.
