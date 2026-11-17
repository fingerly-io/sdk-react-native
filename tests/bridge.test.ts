/**
 * Contract and unit suite for `@fingerly/react-native` (`0.3.0`, `v: 3`).
 */

import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import { NativeModules, Platform } from './stub-react-native.js'

import type {
  FingerlyConfig,
  FingerlyOptions,
  IdentifyOptions,
  IdentifyResult,
  NativeIdentifyResult,
  RiskSignal,
  SignalReport,
  SuspectLevel,
} from '../src/index.js'

// Imported after the stub so the module under test binds to the same objects.
const { ConsentError, FingerlyError, deleteStoredIdentity, load, nativeVersion } = await import('../src/index.js')

/** A native module that records what it was handed. */
function installNative() {
  const configure = vi.fn()
  const identify = vi.fn(async () =>
    JSON.stringify({
      requestId: 'req_123',
      visitorId: 'vis_7Kq3',
      visitorIsNew: false,
      visitorConfidence: 93,
      identifiable: true,
      duplicate: false,
      state: 'enriched',
      reason: '',
      suspectScore: 41,
      suspectLevel: 'high',
      triggers: [
        { signal: 'tampering', group: 'integrity', weight: 22, confidence: 'high', reason: '' },
      ],
      verdicts: { jailbreak: { value: false, confidence: 'low', reasons: [] } },
      report: { schema: 2, sources: {} },
    }),
  )
  const collect = vi.fn(async () => JSON.stringify({ schema: 2, sources: {} }))
  const setConsent = vi.fn()

  NativeModules.Fingerly = { configure, setConsent, identify, collect, sdkVersion: '0.3.0' }
  return { configure, setConsent, identify, collect }
}

/**
 * A native module that refuses the way both native bridges do.
 */
function installGatedNative(shape: 'ios' | 'android' = 'ios') {
  let consent = 'pending'
  const refusal = () => {
    const message = `Fingerly needs consent before it can identify this visitor (consent is ${consent})`
    return shape === 'ios'
      ? Object.assign(new Error(message), {
          code: 'consent_required',
          domain: 'io.fingerly.sdk',
          userInfo: { code: 'consent_required', state: consent },
        })
      : Object.assign(new Error(message), { code: 'consent_required', userInfo: null })
  }

  const configure = vi.fn(
    (_apiKey: string, _endpoint: string, _platform: string, state: string, _projectNumber: number) => {
      consent = state
    },
  )
  const setConsent = vi.fn((state: string) => {
    consent = state
  })
  const identify = vi.fn(async () => {
    if (consent !== 'granted') throw refusal()
    return JSON.stringify({
      requestId: 'req_after_consent',
      visitorId: 'vis_after_consent',
      visitorIsNew: true,
      visitorConfidence: 0,
      identifiable: true,
      duplicate: false,
      state: 'enriched',
      report: { schema: 2, sources: {} },
    })
  })
  const collect = vi.fn(async () => {
    if (consent !== 'granted') throw refusal()
    return JSON.stringify({ schema: 2, sources: {} })
  })

  NativeModules.Fingerly = { configure, setConsent, identify, collect, sdkVersion: '0.3.0' }
  return { configure, setConsent, identify, collect }
}

beforeEach(() => {
  delete NativeModules.Fingerly
  Platform.OS = 'ios'
})

describe('the platform name', () => {
  it('names the host as well as the toolkit on iOS', async () => {
    const { configure } = installNative()
    await load({ apiKey: 'fly_pk_development_test' })

    expect(configure).toHaveBeenCalledWith('fly_pk_development_test', '', 'react-native-ios', 'pending', 0)
  })

  it('names the host as well as the toolkit on Android', async () => {
    Platform.OS = 'android'
    const { configure } = installNative()
    await load({ apiKey: 'fly_pk_development_test' })

    expect(configure).toHaveBeenCalledWith('fly_pk_development_test', '', 'react-native-android', 'pending', 0)
  })

  it('never reports the bare toolkit, which the server scores as a browser', async () => {
    for (const os of ['ios', 'android'] as const) {
      Platform.OS = os
      const { configure } = installNative()
      await load({ apiKey: 'fly_pk_development_test' })

      const platform = configure.mock.calls[0]?.[2] as string
      expect(platform === 'react-native' || platform === 'flutter' || platform === 'lynx').toBe(false)
      expect(/ios|android/.test(platform)).toBe(true)
    }
  })
})

describe('Play Integrity and FingerlyConfig', () => {
  it('hands playIntegrityCloudProjectNumber to the Android module', async () => {
    Platform.OS = 'android'
    const config: FingerlyConfig = {
      apiKey: 'fly_pk_development_test',
      playIntegrityCloudProjectNumber: 123456789012,
    }
    const { configure } = installNative()
    await load(config)

    expect(configure).toHaveBeenCalledWith(
      'fly_pk_development_test',
      '',
      'react-native-android',
      'pending',
      123456789012,
    )
  })

  it('hands playIntegrityCloudProjectNumber across the iOS bridge where FingerlyModule.swift safely ignores it', async () => {
    Platform.OS = 'ios'
    const { configure } = installNative()
    await load({ apiKey: 'fly_pk_development_test', playIntegrityCloudProjectNumber: 123456789012 })

    expect(configure).toHaveBeenCalledWith(
      'fly_pk_development_test',
      '',
      'react-native-ios',
      'pending',
      123456789012,
    )
  })

  it('refuses invalid playIntegrityCloudProjectNumber values on both platforms before configuring anything', async () => {
    for (const os of ['ios', 'android'] as const) {
      Platform.OS = os
      for (const bad of [0, -5, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '123456789012']) {
        const { configure } = installNative()
        await expect(
          load({ apiKey: 'fly_pk_development_test', playIntegrityCloudProjectNumber: bad as number }),
        ).rejects.toThrow(TypeError)
        expect(configure).not.toHaveBeenCalled()
      }
    }
  })
})

describe('when the native module is missing', () => {
  it('says what to do about it rather than throwing on undefined', async () => {
    await expect(load({ apiKey: 'fly_pk_development_test' })).rejects.toThrow(/pod install/)
  })

  it('explains why a JavaScript-only fallback is not offered', async () => {
    await expect(load({ apiKey: 'fly_pk_development_test' })).rejects.toThrow(/clean/)
  })
})

describe('identify and v3 Option B contract', () => {
  it('passes the tag through and defaults to submitting', async () => {
    const { identify } = installNative()
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    await fingerly.identify({ tag: 'checkout' })

    expect(identify).toHaveBeenCalledWith('checkout', true, false)
  })

  it('sends a null tag rather than undefined, which the bridge cannot carry', async () => {
    const { identify } = installNative()
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    await fingerly.identify()

    expect(identify).toHaveBeenCalledWith(null, true, false)
  })

  it('honours submit: false', async () => {
    const { identify } = installNative()
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    await fingerly.identify({ submit: false })

    expect(identify).toHaveBeenCalledWith(null, false, false)
  })

  it('passes automatic through, false unless asked for', async () => {
    const { identify } = installNative()
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    await fingerly.identify({ tag: 'timer', automatic: true })

    expect(identify).toHaveBeenCalledWith('timer', true, true)
  })

  it('parses the native result rather than handing back a string', async () => {
    installNative()
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    const result = await fingerly.identify()

    expect(result.requestId).toBe('req_123')
    expect(result.report.schema).toBe(2)
  })

  it("carries the server's answer across the bridge", async () => {
    installNative()
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    const result = await fingerly.identify()

    expect(result.visitorId).toBe('vis_7Kq3')
    expect(result.visitorIsNew).toBe(false)
    expect(result.visitorConfidence).toBe(93)
    expect(result.identifiable).toBe(true)
    expect(result.duplicate).toBe(false)
    expect(result.state).toBe('enriched')
    expect(result.suspectScore).toBe(41)
    expect(result.suspectLevel).toBe('high')
    expect(result).not.toHaveProperty('triggers')
  })

  it('enforces Option B empty visitorId and visitorIsNew: false when identifiable === false', async () => {
    const { identify } = installNative()
    identify.mockResolvedValue(
      JSON.stringify({
        requestId: 'req_unidentifiable',
        visitorId: '',
        visitorIsNew: false,
        visitorConfidence: 0,
        identifiable: false,
        duplicate: false,
        state: 'enriched',
        suspectScore: 34,
        suspectLevel: 'high',
        report: { schema: 2, sources: {} },
      }),
    )
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    const result = await fingerly.identify()

    expect(result.identifiable).toBe(false)
    expect(result.visitorId).toBe('')
    expect(result.visitorIsNew).toBe(false)
    expect(result.visitorConfidence).toBe(0)
    expect(result.state).toBe('enriched')
    expect(result.suspectScore).toBe(34)
    expect(result.suspectLevel).toBe('high')
  })

  it('clamps stale or forged visitorId and visitorIsNew when identifiable === false or visitorId === ""', async () => {
    const { identify } = installNative()
    identify.mockResolvedValueOnce(
      JSON.stringify({
        requestId: 'req_forged_1',
        visitorId: 'vis_should_not_exist',
        visitorIsNew: true,
        visitorConfidence: 0,
        identifiable: false,
        state: 'enriched',
        report: { schema: 2, sources: {} },
      }),
    )
    identify.mockResolvedValueOnce(
      JSON.stringify({
        requestId: 'req_forged_2',
        visitorId: '',
        visitorIsNew: true,
        visitorConfidence: 0,
        identifiable: true,
        state: 'enriched',
        report: { schema: 2, sources: {} },
      }),
    )

    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })

    const first = await fingerly.identify()
    expect(first.identifiable).toBe(false)
    expect(first.visitorId).toBe('')
    expect(first.visitorIsNew).toBe(false)

    const second = await fingerly.identify()
    expect(second.visitorId).toBe('')
    expect(second.visitorIsNew).toBe(false)
  })

  it('carries a score from an answer that has no signals', async () => {
    const { identify } = installNative()
    identify.mockResolvedValue(
      JSON.stringify({
        requestId: 'req_1',
        visitorId: 'vis_1',
        suspectScore: 18,
        suspectLevel: 'medium',
        report: { schema: 2, sources: {} },
      }),
    )
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    const result = await fingerly.identify()

    expect(result.suspectScore).toBe(18)
    expect(result.suspectLevel).toBe('medium')
    expect(result).not.toHaveProperty('triggers')
  })

  it('reads an answer with neither score nor signals, the same as a hidden score', async () => {
    const { identify } = installNative()
    identify.mockResolvedValue(
      JSON.stringify({ requestId: 'req_1', visitorId: 'vis_1', state: 'enriched', report: { schema: 2, sources: {} } }),
    )
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    const result = await fingerly.identify()

    expect(result.requestId).toBe('req_1')
    expect(result.visitorId).toBe('vis_1')
    expect(result.suspectScore).toBeNull()
    expect(result.suspectLevel).toBeNull()
    expect(result).not.toHaveProperty('triggers')
  })

  it('keeps an unscored answer null rather than zero', async () => {
    NativeModules.Fingerly = {
      configure: vi.fn(),
      identify: vi.fn(async () =>
        JSON.stringify({
          requestId: 'req_1',
          visitorId: 'vis_1',
          suspectScore: null,
          suspectLevel: null,
          report: { schema: 2, sources: {} },
        }),
      ),
      collect: vi.fn(),
      sdkVersion: '0.3.0',
    }

    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    const result = await fingerly.identify()

    expect(result.suspectScore).toBeNull()
    expect(result.suspectLevel).toBeNull()
    expect(result.suspectScore).not.toBe(0)
    expect(result.suspectLevel).not.toBe('')
  })

  it.each([
    [
      'Android writes null',
      {
        visitorIsNew: null,
        visitorConfidence: null,
        identifiable: null,
        duplicate: null,
        suspectScore: null,
        suspectLevel: null,
      },
    ],
    ['iOS leaves the key out', {}],
  ])('reads an answer the server did not give as null: %s', async (_label, unsaid) => {
    const { identify } = installNative()
    identify.mockResolvedValue(
      JSON.stringify({ requestId: 'req_dup', visitorId: '', state: 'unavailable', report: { schema: 2, sources: {} }, ...unsaid }),
    )
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    const result = await fingerly.identify()

    expect(result.visitorId).toBe('')
    for (const field of [
      'visitorIsNew',
      'visitorConfidence',
      'identifiable',
      'duplicate',
      'suspectScore',
      'suspectLevel',
    ] as const) {
      expect(result[field]).toBeNull()
    }
  })

  it('replays a duplicate verdict with its stored visitor and score fields', async () => {
    const { identify } = installNative()
    identify.mockResolvedValue(
      JSON.stringify({
        requestId: 'req_dup',
        visitorId: 'vis_replayed',
        visitorIsNew: false,
        visitorConfidence: 95,
        identifiable: true,
        duplicate: true,
        state: 'enriched',
        suspectScore: 0,
        suspectLevel: 'low',
        report: { schema: 2, sources: {} },
      }),
    )
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    const result = await fingerly.identify()

    expect(result.duplicate).toBe(true)
    expect(result.visitorId).toBe('vis_replayed')
    expect(result.visitorIsNew).toBe(false)
    expect(result.visitorConfidence).toBe(95)
    expect(result.suspectScore).toBe(0)
    expect(result.suspectLevel).toBe('low')
  })

  it('never hands the app a signal name or weight, even when the native side still sends them', async () => {
    installNative()
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    const result = await fingerly.identify()

    expect(result).not.toHaveProperty('triggers')
    expect(JSON.stringify(result)).not.toContain('tampering')
    expect(JSON.stringify(result)).not.toContain('weight')
  })

  it('never hands the app a local conclusion from a stale or forged native answer', async () => {
    installNative()
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    const result = await fingerly.identify()

    expect(result).not.toHaveProperty('verdicts')
    expect(JSON.stringify(result)).not.toContain('jailbreak')
  })

  it.each([
    ['null', null],
    ['not a list', 'frida'],
    ['an object', { signal: 'frida' }],
    ['a list of anything', ['frida', null, 3, ['x'], { signal: 'frida', weight: 9 }]],
  ])('ignores stale triggers that are %s, and any unknown member', async (_label, triggers) => {
    NativeModules.Fingerly = {
      configure: vi.fn(),
      identify: vi.fn(async () =>
        JSON.stringify({
          requestId: 'req_1',
          suspectScore: 12,
          triggers,
          futureMember: { nested: true },
          report: { schema: 2, sources: {} },
        }),
      ),
      collect: vi.fn(),
      sdkVersion: '0.3.0',
    }
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    const result = await fingerly.identify()

    expect(result.requestId).toBe('req_1')
    expect(result.visitorId).toBe('')
    expect(result.suspectScore).toBe(12)
    expect(result).not.toHaveProperty('triggers')
    expect(result).not.toHaveProperty('futureMember')
    expect(JSON.stringify(result)).not.toContain('frida')
  })

  it('returns only the raw report for submit: false', async () => {
    installNative()
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })

    await expect(fingerly.identify({ submit: false })).resolves.toEqual({ report: { schema: 2, sources: {} } })
  })

  it.each([
    ['missing', {}],
    ['null', { report: null }],
    ['text', { report: 'text' }],
    ['a list', { report: [1] }],
  ])('rejects submit: false when the report is %s', async (_label, answer) => {
    NativeModules.Fingerly = {
      configure: vi.fn(),
      identify: vi.fn(async () => JSON.stringify(answer)),
      collect: vi.fn(),
      sdkVersion: '0.3.0',
    }
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })

    await expect(fingerly.identify({ submit: false })).rejects.toBeInstanceOf(FingerlyError)
  })
})

describe('v3 TypeScript contract re-exports', () => {
  it('syncs IdentifyResult, NativeIdentifyResult, FingerlyConfig, and RiskSignal with @fingerly/types', () => {
    expectTypeOf<FingerlyConfig>().toEqualTypeOf<FingerlyOptions>()
    expectTypeOf<FingerlyConfig['playIntegrityCloudProjectNumber']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<IdentifyOptions>().not.toHaveProperty('tiers')
    expectTypeOf<SignalReport>().not.toHaveProperty('tiers')
    expectTypeOf<IdentifyResult>().not.toHaveProperty('deferred')
    expectTypeOf<IdentifyResult>().not.toHaveProperty('deferredToken')
    expectTypeOf<IdentifyResult>().not.toHaveProperty('verdicts')
    expectTypeOf<IdentifyResult['visitorId']>().toEqualTypeOf<string>()
    expectTypeOf<IdentifyResult['visitorIsNew']>().toEqualTypeOf<boolean>()
    expectTypeOf<NativeIdentifyResult['visitorId']>().toEqualTypeOf<string>()
    expectTypeOf<NativeIdentifyResult['suspectLevel']>().toEqualTypeOf<SuspectLevel | null>()

    const signals = [
      'attestation_failed',
      'attestation_missing',
      'attestation_downgrade',
      'play_device_integrity_failed',
      'play_app_unrecognized',
      'device_inconsistent',
      'report_incomplete',
      'probe_errors',
      'tampering',
      'custom_root_ca',
      'secondary_user_profile',
      'frida',
      'mitm_attack',
      'root_apps',
      'jailbreak',
      'app_cloner',
      'emulator',
      'simulator',
      'embedded_web_view',
    ] as const satisfies readonly RiskSignal[]

    expect(signals.length).toBeGreaterThan(10)
  })
})

describe('native failures and error codes', () => {
  it.each([
    [401, 'invalid sdk key'],
    [402, 'organisation disabled'],
    [403, 'attestation_key_unknown'],
    [503, 'service unavailable'],
  ])('preserves HTTP status %i without exposing platform-specific error shapes', async (status, message) => {
    const nativeError = Object.assign(new Error(message), { code: String(status) })
    NativeModules.Fingerly = {
      configure: vi.fn(),
      identify: vi.fn(async () => {
        throw nativeError
      }),
      collect: vi.fn(async () => JSON.stringify({ schema: 2, sources: {} })),
      sdkVersion: '0.3.0',
    }

    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })

    await expect(fingerly.identify()).rejects.toMatchObject({
      name: 'FingerlyError',
      message,
      status,
    })
  })

  it.each(['ios', 'android'] as const)('carries retryAfterMs on 429 errors across %s', async (os) => {
    Platform.OS = os
    const nativeError = Object.assign(new Error('Too many requests'), {
      code: '429',
      userInfo: { retryable: true, retryAfterMs: 3000 },
    })
    NativeModules.Fingerly = {
      configure: vi.fn(),
      identify: vi.fn(async () => {
        throw nativeError
      }),
      collect: vi.fn(),
      sdkVersion: '0.3.0',
    }

    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })

    await expect(fingerly.identify()).rejects.toMatchObject({
      name: 'FingerlyError',
      status: 429,
      retryAfterMs: 3000,
    })
  })

  it('leaves retryAfterMs undefined when no usable wait was named', async () => {
    for (const userInfo of [undefined, null, { retryAfterMs: '3' }, { retryAfterMs: -5 }]) {
      const nativeError = Object.assign(new Error('unavailable'), { code: '503', userInfo })
      NativeModules.Fingerly = {
        configure: vi.fn(),
        identify: vi.fn(async () => {
          throw nativeError
        }),
        collect: vi.fn(),
        sdkVersion: '0.3.0',
      }
      const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
      const error = await fingerly.identify().catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(FingerlyError)
      expect((error as InstanceType<typeof FingerlyError>).retryAfterMs).toBeUndefined()
    }
  })

  it.each(['-1', 'transport', 'collection'])('does not mistake non-HTTP code %s for an HTTP status', async (code) => {
    const nativeError = Object.assign(new Error('no report'), { code })
    NativeModules.Fingerly = {
      configure: vi.fn(),
      identify: vi.fn(async () => JSON.stringify({})),
      collect: vi.fn(async () => {
        throw nativeError
      }),
      sdkVersion: '0.3.0',
    }

    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })

    await expect(fingerly.collect()).rejects.toMatchObject({
      name: 'FingerlyError',
      message: 'no report',
      status: undefined,
    })
  })
})

describe('unreadable native answers', () => {
  it('rejects with a FingerlyError rather than a SyntaxError or TypeError', async () => {
    for (const raw of ['not json', 'null', '[1, 2]', '"text"']) {
      NativeModules.Fingerly = {
        configure: vi.fn(),
        identify: vi.fn(async () => raw),
        collect: vi.fn(async () => raw),
        sdkVersion: '0.3.0',
      }
      const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
      await expect(fingerly.identify(), raw).rejects.toBeInstanceOf(FingerlyError)
      await expect(fingerly.collect(), raw).rejects.toBeInstanceOf(FingerlyError)
    }
  })

  it('passes on only what the server tells an app', async () => {
    NativeModules.Fingerly = {
      configure: vi.fn(),
      identify: vi.fn(async () =>
        JSON.stringify({
          requestId: 'req_1',
          state: 'unavailable',
          reason: 'ip-database-not-loaded',
          report: { schema: 2, sources: {} },
          somethingNew: { a: 1 },
        }),
      ),
      collect: vi.fn(),
      sdkVersion: '0.3.0',
    }
    const result = await (await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })).identify()
    expect(result.requestId).toBe('req_1')
    expect(result.state).toBe('unavailable')
    expect(result).not.toHaveProperty('reason')
    expect(result).not.toHaveProperty('somethingNew')
  })
})

describe('consent', () => {
  it('defaults to pending, so nothing is identified until consent is granted', async () => {
    const { configure, identify, collect } = installGatedNative('ios')
    const fingerly = await load({ apiKey: 'fly_pk_development_test' })

    expect(configure.mock.calls[0]?.[3]).toBe('pending')
    expect(fingerly.consent).toBe('pending')
    await expect(fingerly.identify()).rejects.toMatchObject({
      name: 'ConsentError',
      code: 'consent_required',
      state: 'pending',
    })
    await expect(fingerly.collect()).rejects.toBeInstanceOf(ConsentError)
    expect(identify).toHaveBeenCalledOnce()
    expect(collect).toHaveBeenCalledOnce()
  })

  it.each(['granted', 'pending', 'denied'] as const)('passes %s through to the native configure', async (consent) => {
    const { configure } = installNative()
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent })

    expect(configure).toHaveBeenCalledWith('fly_pk_development_test', '', 'react-native-ios', consent, 0)
    expect(fingerly.consent).toBe(consent)
  })

  it('refuses a value that is not a consent state before configuring anything', async () => {
    const { configure } = installNative()

    await expect(
      load({ apiKey: 'fly_pk_development_test', consent: 'accepted' as unknown as 'granted' }),
    ).rejects.toThrow(TypeError)
    expect(configure).not.toHaveBeenCalled()
  })

  it('forwards setConsent to the native module and keeps the getter in step', async () => {
    const { setConsent } = installNative()
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'pending' })

    fingerly.setConsent('granted')
    expect(setConsent).toHaveBeenLastCalledWith('granted')
    expect(fingerly.consent).toBe('granted')

    fingerly.setConsent('denied')
    expect(setConsent).toHaveBeenLastCalledWith('denied')
    expect(fingerly.consent).toBe('denied')
  })

  it('does not forward an unknown state from setConsent', async () => {
    const { setConsent } = installNative()
    const fingerly = await load({ apiKey: 'fly_pk_development_test' })

    expect(() => fingerly.setConsent(true as unknown as 'granted')).toThrow(TypeError)
    expect(setConsent).not.toHaveBeenCalled()
    expect(fingerly.consent).toBe('pending')
  })

  it.each(['pending', 'denied'] as const)(
    'turns an iOS consent_required rejection into a ConsentError (%s)',
    async (consent) => {
      installGatedNative('ios')
      const fingerly = await load({ apiKey: 'fly_pk_development_test', consent })

      const failure = await fingerly.identify().catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ConsentError)
      expect(failure).toBeInstanceOf(FingerlyError)
      expect(failure).toMatchObject({
        name: 'ConsentError',
        code: 'consent_required',
        state: consent,
        status: undefined,
        message: `Fingerly needs consent before it can identify this visitor (consent is ${consent})`,
      })
    },
  )

  it('reads the state from the message when the bridge sends no userInfo, as Android does', async () => {
    Platform.OS = 'android'
    installGatedNative('android')
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'denied' })

    await expect(fingerly.collect()).rejects.toMatchObject({
      name: 'ConsentError',
      code: 'consent_required',
      state: 'denied',
    })
  })

  it('falls back to pending when the refusal does not say which state refused', async () => {
    NativeModules.Fingerly = {
      configure: vi.fn(),
      setConsent: vi.fn(),
      identify: vi.fn(async () => {
        throw Object.assign(new Error('refused'), { code: 'consent_required' })
      }),
      collect: vi.fn(),
      sdkVersion: '0.3.0',
    }
    const fingerly = await load({ apiKey: 'fly_pk_development_test' })

    await expect(fingerly.identify()).rejects.toMatchObject({ name: 'ConsentError', state: 'pending' })
  })

  it('identifies once consent is granted', async () => {
    const { identify } = installGatedNative('ios')
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'pending' })

    await expect(fingerly.identify()).rejects.toBeInstanceOf(ConsentError)
    await expect(fingerly.collect()).rejects.toBeInstanceOf(ConsentError)

    fingerly.setConsent('granted')
    await expect(fingerly.identify()).resolves.toMatchObject({ requestId: 'req_after_consent' })
    expect(identify).toHaveBeenCalledTimes(2)
  })
})

describe('the endpoint', () => {
  it('passes an empty string when unset, so the native default applies', async () => {
    const { configure } = installNative()
    await load({ apiKey: 'fly_pk_development_test' })

    expect(configure.mock.calls[0]?.[1]).toBe('')
  })

  it('passes one through when given', async () => {
    const { configure } = installNative()
    await load({ apiKey: 'fly_pk_development_test', endpoint: 'https://api.example.com' })

    expect(configure).toHaveBeenCalledWith(
      'fly_pk_development_test',
      'https://api.example.com',
      'react-native-ios',
      'pending',
      0,
    )
  })
})

describe('nativeVersion', () => {
  it('reports the version of the SDK that actually did the collecting', async () => {
    installNative()
    expect(nativeVersion()).toBe('0.3.0')
  })

  it('is undefined rather than throwing when there is no native module', () => {
    expect(nativeVersion()).toBeUndefined()
  })
})

describe('deleteStoredIdentity (GDPR / privacy erasure)', () => {
  it('asks the native SDK, without load or consent', async () => {
    const { configure, setConsent } = installNative()
    const remove = vi.fn(async () => null)
    ;(NativeModules.Fingerly as Record<string, unknown>).deleteStoredIdentity = remove

    await expect(deleteStoredIdentity()).resolves.toBeUndefined()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(configure).not.toHaveBeenCalled()
    expect(setConsent).not.toHaveBeenCalled()
  })

  it('says so when the native SDK in the app predates it', async () => {
    installNative()

    await expect(deleteStoredIdentity()).rejects.toBeInstanceOf(FingerlyError)
    await expect(deleteStoredIdentity()).rejects.toThrow(/not available in the native Fingerly SDK on ios/)
  })

  it.each(['ios', 'android'] as const)(
    'surfaces a failed delete on %s as a FingerlyError with no HTTP status',
    async (os) => {
      Platform.OS = os
      installNative()
      ;(NativeModules.Fingerly as Record<string, unknown>).deleteStoredIdentity = vi.fn(async () => {
        throw Object.assign(new Error('Fingerly could not delete its stored install record'), {
          code: 'delete_failed',
          userInfo: os === 'ios' ? { code: 'delete_failed', status: 13 } : null,
        })
      })

      const error = await deleteStoredIdentity().catch((e: unknown) => e)
      expect(error).toBeInstanceOf(FingerlyError)
      expect((error as InstanceType<typeof FingerlyError>).message).toBe(
        'Fingerly could not delete its stored install record',
      )
      expect((error as InstanceType<typeof FingerlyError>).status).toBeUndefined()
    },
  )

  it('reports the missing native module rather than throwing on undefined', async () => {
    await expect(deleteStoredIdentity()).rejects.toThrow(/could not find its native module/)
  })

  it('documents GDPR-only erasure of install_id and hardware attestation key state', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/GDPR \/ privacy erasure/i)
    expect(source).toContain('install_id')
    expect(source).toMatch(/attestation key state/i)
  })
})

describe('version, native coordinates, and bridge selector parity (0.3.0)', () => {
  it('aligns package.json, podspec, fingerly-binary.json, and android/build.gradle at 0.3.0', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    // The @fingerly/types this package resolves: packages/types in this
    // repository, client/web/types when it builds inside the sdks workspace.
    const typesPkg = JSON.parse(
      readFileSync(new URL('../node_modules/@fingerly/types/package.json', import.meta.url), 'utf8'),
    )
    const binary = JSON.parse(readFileSync(new URL('../ios/fingerly-binary.json', import.meta.url), 'utf8'))
    const podspec = readFileSync(new URL('../fingerly-react-native.podspec', import.meta.url), 'utf8')
    const gradle = readFileSync(new URL('../android/build.gradle', import.meta.url), 'utf8')
    const manifest = readFileSync(new URL('../android/src/main/AndroidManifest.xml', import.meta.url), 'utf8')
    const fetchScript = readFileSync(new URL('../ios/fetch-fingerly-xcframework.sh', import.meta.url), 'utf8')

    expect(pkg.version).toBe('0.3.0')
    // The contract types may move ahead of the bridge; it needs the v3 types from 0.3.0 on.
    const [typesMajor, typesMinor] = typesPkg.version.split('.').map(Number)
    expect(typesMajor === 0 && (typesMinor ?? 0) >= 3).toBe(true)
    expect(podspec).toMatch(/s\.version\s*=\s*'0\.3\.0'/)
    expect(binary).toEqual({
      version: '0.3.0',
      url: 'https://maven.fingerly.io/ios/Fingerly-0.3.0.xcframework.zip',
      sha256: 'b3288cc4539b6c5b8bae226854a586473b2457489e69b2ac1f26e9f84f6add27',
      team_id: 'XGXX88HRR5',
    })
    expect(fetchScript).toContain('FINGERLY_XCFRAMEWORK_PATH')
    expect(fetchScript).toContain('anchor apple generic and certificate leaf[subject.OU]')
    expect(gradle).toContain('mavenLocal()')
    expect(gradle).toContain("implementation 'io.fingerly:fingerly:0.3.0'")
    expect(gradle).not.toMatch(/^\s*(implementation|api)\s+['"]io\.fingerly:fingerly-(app-checks|play-integrity)/m)
    expect(manifest.replace(/<!--[\s\S]*?-->/g, '')).not.toContain('<queries')
  })

  it('keeps Objective-C RCT_EXTERN_METHOD and Swift @objc selectors in exact agreement', () => {
    const objc = readFileSync(new URL('../ios/FingerlyModule.m', import.meta.url), 'utf8')
    const swift = readFileSync(new URL('../ios/FingerlyModule.swift', import.meta.url), 'utf8')

    for (const selector of [
      'configure:endpoint:platform:consent:playIntegrityCloudProjectNumber:',
      'setConsent:',
      'identify:submit:automatic:resolver:rejecter:',
      'collect:rejecter:',
      'deleteStoredIdentity:rejecter:',
    ]) {
      expect(swift).toContain(`@objc(${selector})`)
    }
    expect(objc).toContain('playIntegrityCloudProjectNumber:(nonnull NSNumber *)playIntegrityCloudProjectNumber')
  })
})
