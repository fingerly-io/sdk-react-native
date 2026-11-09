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
      state: 'scored',
      reason: '',
      suspectScore: 41,
      suspectLevel: 'medium',
      triggers: [
        { signal: 'patched-natives', group: 'automation', weight: 22, confidence: 'high', reason: '' },
      ],
      verdicts: { jailbreak: { value: false, confidence: 'low', reasons: [] } },
      report: { schema: 1, sources: {} },
    }),
  )
  const collect = vi.fn(async () => JSON.stringify({ schema: 1, sources: {} }))
  const setConsent = vi.fn()

  NativeModules.Fingerly = { configure, setConsent, identify, collect, sdkVersion: '0.1.0' }
  return { configure, setConsent, identify, collect }
}

/**
 * A native module that refuses the way both native bridges do.
 *
 * It keeps its own consent, exactly as `FingerlyBridge` does, and rejects
 * `identify` and `collect` with `consent_required` until that consent is
 * `granted`. `shape` picks which platform's rejection to imitate: iOS passes
 * the NSError through, so its `userInfo.state` arrives; Android sends a code
 * and a message only.
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

  const configure = vi.fn((_apiKey: string, _endpoint: string, _platform: string, state: string) => {
    consent = state
  })
  const setConsent = vi.fn((state: string) => {
    consent = state
  })
  const identify = vi.fn(async () => {
    if (consent !== 'granted') throw refusal()
    return JSON.stringify({ requestId: 'req_after_consent', report: { schema: 1, sources: {} } })
  })
  const collect = vi.fn(async () => {
    if (consent !== 'granted') throw refusal()
    return JSON.stringify({ schema: 1, sources: {} })
  })

  NativeModules.Fingerly = { configure, setConsent, identify, collect, sdkVersion: '0.1.0' }
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

    expect(configure).toHaveBeenCalledWith('fly_pk_development_test', '', 'react-native-ios', 'pending')
  })

  it('names the host as well as the toolkit on Android', async () => {
    Platform.OS = 'android'
    const { configure } = installNative()
    await load({ apiKey: 'fly_pk_development_test' })

    expect(configure).toHaveBeenCalledWith('fly_pk_development_test', '', 'react-native-android', 'pending')
  })

  it('never reports the bare toolkit, which the server scores as a browser', async () => {
    for (const os of ['ios', 'android'] as const) {
      Platform.OS = os
      const { configure } = installNative()
      await load({ apiKey: 'fly_pk_development_test' })

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
    await expect(load({ apiKey: 'fly_pk_development_test' })).rejects.toThrow(/pod install/)
  })

  it('explains why a JavaScript-only fallback is not offered', async () => {
    // The message is load-bearing. The obvious "fix" for a missing native
    // module is to collect what JavaScript can reach, and that would report a
    // jailbroken, instrumented device as clean — which is worse than failing,
    // because a customer would believe it.
    await expect(load({ apiKey: 'fly_pk_development_test' })).rejects.toThrow(/clean/)
  })
})

describe('identify', () => {
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
    expect(result.report.schema).toBe(1)
  })

  it('carries the server\'s answer across the bridge', async () => {
    // The bridge is a JSON string, so every field the native SDKs added has to
    // survive a round trip through it. A field the native side sends and this
    // side drops is invisible until an app reads undefined in production.
    installNative()
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    const result = await fingerly.identify()

    expect(result.visitorId).toBe('vis_7Kq3')
    expect(result.visitorIsNew).toBe(false)
    expect(result.visitorConfidence).toBe(93)
    expect(result.identifiable).toBe(true)
    expect(result.duplicate).toBe(false)
    expect(result.state).toBe('scored')
    expect(result.suspectScore).toBe(41)
    expect(result.suspectLevel).toBe('medium')
    expect(result).not.toHaveProperty('triggers')
  })

  it('carries a score from an answer that has no signals', async () => {
    const { identify } = installNative()
    identify.mockResolvedValue(
      JSON.stringify({ requestId: 'req_1', visitorId: 'vis_1', suspectScore: 41, suspectLevel: 'medium', report: { schema: 1, sources: {} } }),
    )
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    const result = await fingerly.identify()

    expect(result.suspectScore).toBe(41)
    expect(result.suspectLevel).toBe('medium')
    expect(result).not.toHaveProperty('triggers')
  })

  it('reads an answer with neither score nor signals, the same as a hidden score', async () => {
    const { identify } = installNative()
    identify.mockResolvedValue(
      JSON.stringify({ requestId: 'req_1', visitorId: 'vis_1', state: 'scored', report: { schema: 1, sources: {} } }),
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
    // Both native bridges send an explicit JSON null for suspectScore when
    // nothing scored the submission. Null and 0 are different answers - 0 is
    // "scored, nothing fired" - and collapsing them here would report a clean
    // visitor for a check that never happened.
    NativeModules.Fingerly = {
      configure: vi.fn(),
      identify: vi.fn(async () =>
        JSON.stringify({
          requestId: 'req_1',
          visitorId: 'vis_1',
          suspectScore: null,
          suspectLevel: null,
          report: { schema: 1, sources: {} },
        }),
      ),
      collect: vi.fn(),
      sdkVersion: '0.1.0',
    }

    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    const result = await fingerly.identify()

    expect(result.suspectScore).toBeNull()
    expect(result.suspectLevel).toBeNull()
    expect(result.suspectScore).not.toBe(0)
    expect(result.suspectLevel).not.toBe('')
  })

  it.each([
    ['Android writes null', { visitorIsNew: null, visitorConfidence: null, identifiable: null, duplicate: null, suspectScore: null, suspectLevel: null }],
    ['iOS leaves the key out', {}],
  ])('reads an answer the server did not give as null: %s', async (_label, unsaid) => {
    const { identify } = installNative()
    identify.mockResolvedValue(
      JSON.stringify({ requestId: 'req_dup', visitorId: '', state: 'scored', report: { schema: 1, sources: {} }, ...unsaid }),
    )
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    const result = await fingerly.identify()

    for (const field of ['visitorIsNew', 'visitorConfidence', 'identifiable', 'duplicate', 'suspectScore', 'suspectLevel'] as const) {
      expect(result[field]).toBeNull()
    }
  })

  it('keeps a duplicate answer true with its visitor fields empty', async () => {
    const { identify } = installNative()
    identify.mockResolvedValue(
      JSON.stringify({ requestId: 'req_dup', visitorId: '', duplicate: true, state: 'scored', report: { schema: 1, sources: {} } }),
    )
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    const result = await fingerly.identify()

    expect(result.duplicate).toBe(true)
    expect(result.visitorId).toBe('')
    expect(result.visitorConfidence).toBeNull()
  })

  it('never hands the app a signal name or weight, even when the native side still sends them', async () => {
    // installNative answers like an older native build, with a trigger in it.
    installNative()
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    const result = await fingerly.identify()

    expect(result).not.toHaveProperty('triggers')
    expect(JSON.stringify(result)).not.toContain('patched-natives')
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
        JSON.stringify({ requestId: 'req_1', suspectScore: 12, triggers, futureMember: { nested: true }, report: { schema: 1, sources: {} } }),
      ),
      collect: vi.fn(),
      sdkVersion: '0.1.0',
    }
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
    const result = await fingerly.identify()

    expect(result.requestId).toBe('req_1')
    expect(result.suspectScore).toBe(12)
    expect(result).not.toHaveProperty('triggers')
    expect(result).not.toHaveProperty('futureMember')
    expect(JSON.stringify(result)).not.toContain('frida')
  })

  it('returns only the raw report for submit: false', async () => {
    // Forged on purpose: an answer full of server fields and a local conclusion
    // for a check nobody sent. None of it may survive.
    installNative()
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })

    await expect(fingerly.identify({ submit: false })).resolves.toEqual({ report: { schema: 1, sources: {} } })
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
      sdkVersion: '0.1.0',
    }
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })

    await expect(fingerly.identify({ submit: false })).rejects.toBeInstanceOf(FingerlyError)
  })
})

describe('native failures', () => {
  it('preserves an HTTP status without exposing platform-specific error shapes', async () => {
    const nativeError = Object.assign(new Error('organisation disabled'), { code: '402' })
    NativeModules.Fingerly = {
      configure: vi.fn(),
      identify: vi.fn(async () => {
        throw nativeError
      }),
      collect: vi.fn(async () => JSON.stringify({ schema: 1, sources: {} })),
      sdkVersion: '0.1.0',
    }

    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })

    await expect(fingerly.identify()).rejects.toMatchObject({
      name: 'FingerlyError',
      message: 'organisation disabled',
      status: 402,
    })
  })

  it('carries the iOS bridge retryAfterMs on the error', async () => {
    // What RCTPromiseRejectBlock delivers for the iOS bridge's NSError.
    const nativeError = Object.assign(new Error('Too many requests'), {
      code: '429',
      domain: 'io.fingerly.sdk',
      userInfo: { retryable: true, retryAfterMs: 3000 },
    })
    NativeModules.Fingerly = {
      configure: vi.fn(),
      identify: vi.fn(async () => {
        throw nativeError
      }),
      collect: vi.fn(),
      sdkVersion: '0.1.0',
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
        sdkVersion: '0.1.0',
      }
      const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
      const error = await fingerly.identify().catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(FingerlyError)
      expect((error as InstanceType<typeof FingerlyError>).retryAfterMs).toBeUndefined()
    }
  })

  it('does not mistake a native sentinel code for an HTTP status', async () => {
    const nativeError = Object.assign(new Error('no report'), { code: '-1' })
    NativeModules.Fingerly = {
      configure: vi.fn(),
      identify: vi.fn(async () => JSON.stringify({})),
      collect: vi.fn(async () => {
        throw nativeError
      }),
      sdkVersion: '0.1.0',
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
        sdkVersion: '0.1.0',
      }
      const fingerly = await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })
      await expect(fingerly.identify(), raw).rejects.toBeInstanceOf(FingerlyError)
      await expect(fingerly.collect(), raw).rejects.toBeInstanceOf(FingerlyError)
    }
  })

  it('tolerates a result without reason and with members it does not know', async () => {
    NativeModules.Fingerly = {
      configure: vi.fn(),
      identify: vi.fn(async () =>
        JSON.stringify({ requestId: 'req_1', report: { schema: 1, sources: {} }, somethingNew: { a: 1 } }),
      ),
      collect: vi.fn(),
      sdkVersion: '0.1.0',
    }
    const result = await (await load({ apiKey: 'fly_pk_development_test', consent: 'granted' })).identify()
    expect(result.requestId).toBe('req_1')
    expect(result.reason).toBeUndefined()
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
    // Refused by the native SDK before it collected or sent anything; nothing
    // came back to resolve with.
    expect(identify).toHaveBeenCalledOnce()
    expect(collect).toHaveBeenCalledOnce()
  })

  it.each(['granted', 'pending', 'denied'] as const)('passes %s through to the native configure', async (consent) => {
    const { configure } = installNative()
    const fingerly = await load({ apiKey: 'fly_pk_development_test', consent })

    expect(configure).toHaveBeenCalledWith('fly_pk_development_test', '', 'react-native-ios', consent)
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
      sdkVersion: '0.1.0',
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

    // Not `undefined`: the bridge signature is a non-null string, and the
    // native side treats empty as "use the default". Sending undefined across
    // the bridge would arrive as null and fail the argument check.
    expect(configure.mock.calls[0]?.[1]).toBe('')
  })

  it('passes one through when given', async () => {
    const { configure } = installNative()
    await load({ apiKey: 'fly_pk_development_test', endpoint: 'https://api.example.com' })

    expect(configure).toHaveBeenCalledWith('fly_pk_development_test', 'https://api.example.com', 'react-native-ios', 'pending')
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

describe('deleteStoredIdentity', () => {
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

  it('surfaces a failed delete as a FingerlyError, as both native modules reject it', async () => {
    Platform.OS = 'android'
    installNative()
    ;(NativeModules.Fingerly as Record<string, unknown>).deleteStoredIdentity = vi.fn(async () => {
      throw Object.assign(new Error('Fingerly could not delete its stored install record'), {
        code: 'delete_failed',
      })
    })

    const error = await deleteStoredIdentity().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FingerlyError)
    expect((error as InstanceType<typeof FingerlyError>).message).toBe(
      'Fingerly could not delete its stored install record',
    )
    expect((error as InstanceType<typeof FingerlyError>).status).toBeUndefined()
  })

  it('reports the missing native module rather than throwing on undefined', async () => {
    await expect(deleteStoredIdentity()).rejects.toThrow(/could not find its native module/)
  })
})
