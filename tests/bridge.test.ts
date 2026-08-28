/**
 * The bridge, which is almost entirely a contract and almost not at all logic.
 *
 * The test worth having here is the platform name. It is one string, it is
 * assembled in this package, and getting it wrong is invisible: the submission
 * succeeds, the event is stored, and the server scores an iPhone against
 * *browser* weights — where `jailbreak` and `simulator` are not signals at all
 * and everything the native SDK collected is worth zero. Nothing fails, and a
 * customer finds out when a jailbroken device is never flagged.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NativeModules, Platform } from './stub-react-native.js'

// Imported after the stub so the module under test binds to the same objects.
const { load, nativeVersion } = await import('../src/index.js')

/** A native module that records what it was handed. */
function installNative() {
  const configure = vi.fn()
  const identify = vi.fn(async () =>
    JSON.stringify({
      requestId: 'req_123',
      verdicts: { jailbreak: { value: false, confidence: 'low', reasons: [] } },
      report: { schema: 1, sources: {} },
    }),
  )
  const collect = vi.fn(async () => JSON.stringify({ schema: 1, sources: {} }))

  NativeModules.Badele = { configure, identify, collect, sdkVersion: '0.1.0' }
  return { configure, identify, collect }
}

beforeEach(() => {
  delete NativeModules.Badele
  Platform.OS = 'ios'
})

describe('the platform name', () => {
  it('names the host as well as the toolkit on iOS', async () => {
    const { configure } = installNative()
    await load({ apiKey: 'pk_test' })

    expect(configure).toHaveBeenCalledWith('pk_test', '', 'react-native-ios')
  })

  it('names the host as well as the toolkit on Android', async () => {
    Platform.OS = 'android'
    const { configure } = installNative()
    await load({ apiKey: 'pk_test' })

    expect(configure).toHaveBeenCalledWith('pk_test', '', 'react-native-android')
  })

  it('never reports the bare toolkit, which the server scores as a browser', async () => {
    for (const os of ['ios', 'android'] as const) {
      Platform.OS = os
      const { configure } = installNative()
      await load({ apiKey: 'pk_test' })

      const platform = configure.mock.calls[0]?.[2] as string
      // `models.RiskPlatformFor` matches "android" first, then "ios", and falls
      // back to the web profile when it finds neither.
      expect(platform === 'react-native' || platform === 'flutter').toBe(false)
      expect(/ios|android/.test(platform)).toBe(true)
    }
  })
})

describe('when the native module is missing', () => {
  it('says what to do about it rather than throwing on undefined', async () => {
    await expect(load({ apiKey: 'pk_test' })).rejects.toThrow(/pod install/)
  })

  it('explains why a JavaScript-only fallback is not offered', async () => {
    // The message is load-bearing. The obvious "fix" for a missing native
    // module is to collect what JavaScript can reach, and that would report a
    // jailbroken, instrumented device as clean — which is worse than failing,
    // because a customer would believe it.
    await expect(load({ apiKey: 'pk_test' })).rejects.toThrow(/clean/)
  })
})

describe('identify', () => {
  it('passes the tag through and defaults to submitting', async () => {
    const { identify } = installNative()
    const badele = await load({ apiKey: 'pk_test' })
    await badele.identify({ tag: 'checkout' })

    expect(identify).toHaveBeenCalledWith('checkout', true)
  })

  it('sends a null tag rather than undefined, which the bridge cannot carry', async () => {
    const { identify } = installNative()
    const badele = await load({ apiKey: 'pk_test' })
    await badele.identify()

    expect(identify).toHaveBeenCalledWith(null, true)
  })

  it('honours submit: false', async () => {
    const { identify } = installNative()
    const badele = await load({ apiKey: 'pk_test' })
    await badele.identify({ submit: false })

    expect(identify).toHaveBeenCalledWith(null, false)
  })

  it('parses the native result rather than handing back a string', async () => {
    installNative()
    const badele = await load({ apiKey: 'pk_test' })
    const result = await badele.identify()

    expect(result.requestId).toBe('req_123')
    expect(result.verdicts.jailbreak.value).toBe(false)
    expect(result.report.schema).toBe(1)
  })

  it('fills in the verdicts this platform cannot answer', async () => {
    // The iOS SDK does not emit `root`; Android does not emit `jailbreak`.
    // `MobileVerdicts` declares both, so reading one on the wrong platform has
    // to give a well-defined answer rather than throwing on undefined — which
    // would typecheck cleanly and fail at runtime, the worst combination.
    installNative()
    const badele = await load({ apiKey: 'pk_test' })
    const result = await badele.identify()

    expect(result.verdicts.root.value).toBe(false)
    expect(result.verdicts.emulator.value).toBe(false)
    expect(result.verdicts.appCloner.value).toBe(false)
  })

  it('marks an unanswerable verdict with empty reasons, not merely false', async () => {
    // The distinction the fill is careful to preserve: an empty `reasons`
    // beside a false is "this could not be asked", which is what every detector
    // in the codebase returns when its inputs are missing. A caller that needs
    // to tell that from "we looked and found nothing" reads the length.
    installNative()
    const badele = await load({ apiKey: 'pk_test' })
    const result = await badele.identify()

    expect(result.verdicts.root.reasons).toEqual([])
  })
})

describe('the endpoint', () => {
  it('passes an empty string when unset, so the native default applies', async () => {
    const { configure } = installNative()
    await load({ apiKey: 'pk_test' })

    // Not `undefined`: the bridge signature is a non-null string, and the
    // native side treats empty as "use the default". Sending undefined across
    // the bridge would arrive as null and fail the argument check.
    expect(configure.mock.calls[0]?.[1]).toBe('')
  })

  it('passes one through when given', async () => {
    const { configure } = installNative()
    await load({ apiKey: 'pk_test', endpoint: 'https://api.example.com' })

    expect(configure).toHaveBeenCalledWith('pk_test', 'https://api.example.com', 'react-native-ios')
  })
})

describe('nativeVersion', () => {
  it('reports the version of the SDK that actually did the collecting', async () => {
    installNative()
    expect(nativeVersion()).toBe('0.1.0')
  })

  it('is undefined rather than throwing when there is no native module', () => {
    expect(nativeVersion()).toBeUndefined()
  })
})
