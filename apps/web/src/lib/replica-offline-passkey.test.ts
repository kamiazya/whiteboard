/**
 * The passkey kept in this browser to make one cached copy readable offline.
 *
 * Nothing here reaches a daemon, so what a test can pin is the shape of the
 * WebAuthn requests the page makes and how each way they fail is named: the
 * authenticator's verification gesture is the only thing standing between the
 * copy and whoever holds the device, and no later layer would notice a
 * request that stopped demanding it.
 */

import { base64UrlToBytes, bytesToBase64Url } from '@kamiazya/whiteboard-model'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  assertOfflinePasskey,
  browserCredentials,
  createOfflinePasskey,
  dropOfflinePasskey,
  loadOfflinePasskey,
  type OfflinePasskeyCredentials,
  saveOfflinePasskey,
} from './replica-offline-passkey.js'

const DAEMON = 'http://127.0.0.1:3099'
const WORKSPACE = 'ws-1'
const STORE_KEY = 'whiteboard:replica-offline-passkeys'

const PRF_OUTPUT = new Uint8Array(32).fill(7)
const RAW_ID = new Uint8Array([1, 2, 3, 4])
const RECORD = { credentialId: bytesToBase64Url(RAW_ID), prfSalt: bytesToBase64Url(PRF_OUTPUT) }

function credentialWith(extensionResults: unknown): PublicKeyCredential {
  return {
    rawId: RAW_ID.buffer,
    getClientExtensionResults: () => extensionResults,
  } as unknown as PublicKeyCredential
}

/** A credential that evaluated `prf` at the moment it was used. */
const evaluated = (): PublicKeyCredential =>
  credentialWith({ prf: { enabled: true, results: { first: PRF_OUTPUT.slice().buffer } } })

/** A credential that only enabled `prf` — the evaluation comes on assertion. */
const enabledOnly = (): PublicKeyCredential => credentialWith({ prf: { enabled: true } })

function fakeCredentials(
  overrides: Partial<OfflinePasskeyCredentials> = {},
): OfflinePasskeyCredentials & {
  create: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
} {
  return {
    create: vi.fn(async () => evaluated()),
    get: vi.fn(async () => evaluated()),
    ...overrides,
  } as never
}

const namedError = (name: string): Error => Object.assign(new Error(name), { name })

function createdPublicKey(credentials: { create: ReturnType<typeof vi.fn> }, call = 0) {
  const options = credentials.create.mock.calls[call]?.[0] as CredentialCreationOptions
  return options.publicKey as PublicKeyCredentialCreationOptions
}

function requestedPublicKey(credentials: { get: ReturnType<typeof vi.fn> }, call = 0) {
  const options = credentials.get.mock.calls[call]?.[0] as CredentialRequestOptions
  return options.publicKey as PublicKeyCredentialRequestOptions
}

const prfSaltOf = (publicKey: { extensions?: unknown }): Uint8Array =>
  new Uint8Array((publicKey.extensions as { prf: { eval: { first: ArrayBuffer } } }).prf.eval.first)

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the stored record', () => {
  it('keeps one record per daemon and workspace, and a trailing slash names the same daemon', () => {
    saveOfflinePasskey(`${DAEMON}/`, WORKSPACE, RECORD)

    expect(loadOfflinePasskey(DAEMON, WORKSPACE)).toEqual(RECORD)
    expect(loadOfflinePasskey(DAEMON, 'ws-2')).toBeNull()
    expect(loadOfflinePasskey('http://127.0.0.1:4000', WORKSPACE)).toBeNull()
  })

  it('drops one record and leaves the others', () => {
    saveOfflinePasskey(DAEMON, 'a', RECORD)
    saveOfflinePasskey(DAEMON, 'b', RECORD)

    dropOfflinePasskey(DAEMON, 'a')

    expect(loadOfflinePasskey(DAEMON, 'a')).toBeNull()
    expect(loadOfflinePasskey(DAEMON, 'b')).toEqual(RECORD)
  })

  /**
   * Overwrites the stored entry for `workspaceId` with `entry`, leaving its
   * sibling alone, so a test can plant what a hand edit or a newer build
   * would have written.
   */
  function plant(workspaceId: string, entry: unknown): void {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, unknown>
    const key = Object.keys(raw).find((k) => k.endsWith(`\u0000${workspaceId}`))
    if (key === undefined) throw new Error(`no stored entry for ${workspaceId}`)
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...raw, [key]: entry }))
  }

  it.each([
    ['a credential id that is not base64url', { ...RECORD, credentialId: 'AQ+/' }],
    ['a salt that is not base64url', { ...RECORD, prfSalt: 'AQ IDBA' }],
    ['an empty credential id', { ...RECORD, credentialId: '' }],
    ['a field this build does not know', { ...RECORD, transports: ['usb'] }],
  ])('reads %s as absent, and keeps the entry beside it', (_name, bad) => {
    saveOfflinePasskey(DAEMON, 'good', RECORD)
    saveOfflinePasskey(DAEMON, 'bad', RECORD)
    plant('bad', bad)

    expect(loadOfflinePasskey(DAEMON, 'bad')).toBeNull()
    expect(loadOfflinePasskey(DAEMON, 'good')).toEqual(RECORD)
  })

  describe('an entry this build cannot read', () => {
    const NEWER = { ...RECORD, transports: ['usb'] }
    const stored = () =>
      JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, unknown>
    const plantNewer = () => {
      localStorage.setItem(STORE_KEY, JSON.stringify({ 'from-a-newer-build': NEWER }))
    }

    it('survives a save of another pin, in storage', () => {
      plantNewer()
      saveOfflinePasskey(DAEMON, 'ws-2', RECORD)
      expect(stored()['from-a-newer-build']).toEqual(NEWER)
      expect(loadOfflinePasskey(DAEMON, 'ws-2')).toEqual(RECORD)
    })

    it('survives a drop of another pin, in storage', () => {
      plantNewer()
      saveOfflinePasskey(DAEMON, 'ws-2', RECORD)
      dropOfflinePasskey(DAEMON, 'ws-2')
      expect(stored()).toEqual({ 'from-a-newer-build': NEWER })
    })
  })
})

describe('browserCredentials', () => {
  function stubNavigatorCredentials(credentials: unknown): void {
    const original = Object.getOwnPropertyDescriptor(navigator, 'credentials')
    Object.defineProperty(navigator, 'credentials', { value: credentials, configurable: true })
    onTestFinished(() => {
      if (original === undefined) Reflect.deleteProperty(navigator, 'credentials')
      else Object.defineProperty(navigator, 'credentials', original)
    })
  }

  it('is undefined where the page has no WebAuthn, even if the container is there', () => {
    stubNavigatorCredentials(fakeCredentials())
    vi.stubGlobal('PublicKeyCredential', undefined)

    expect(browserCredentials()).toBeUndefined()
  })

  it('is the browser container where WebAuthn exists', () => {
    const credentials = fakeCredentials()
    stubNavigatorCredentials(credentials)
    vi.stubGlobal('PublicKeyCredential', class {})

    expect(browserCredentials()).toBe(credentials)
  })

  it('is what createOfflinePasskey and assertOfflinePasskey use when handed nothing', async () => {
    const credentials = fakeCredentials()
    stubNavigatorCredentials(credentials)
    vi.stubGlobal('PublicKeyCredential', class {})

    const created = await createOfflinePasskey({ label: 'Notes' })
    const asserted = await assertOfflinePasskey(RECORD)

    expect(created.ok).toBe(true)
    expect(asserted.ok).toBe(true)
    expect(credentials.create).toHaveBeenCalledTimes(1)
    expect(credentials.get).toHaveBeenCalledTimes(1)
  })
})

describe('createOfflinePasskey', () => {
  it('asks for a platform-verified, attestation-free credential labelled for its copy', async () => {
    const credentials = fakeCredentials()

    await createOfflinePasskey({ label: 'Notes', credentials })

    const publicKey = createdPublicKey(credentials)
    expect(publicKey.authenticatorSelection?.userVerification).toBe('required')
    expect(publicKey.authenticatorSelection?.residentKey).toBe('preferred')
    // Nothing verifies an attestation, so asking for one would only identify
    // the authenticator model to no purpose.
    expect(publicKey.attestation).toBe('none')
    expect(publicKey.user.name).toBe('Notes (offline copy)')
    expect(publicKey.user.displayName).toBe('Notes (offline copy)')
    expect(publicKey.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -257])
  })

  it('draws a 32-byte salt, asks prf with it, and stores it beside the credential id', async () => {
    const credentials = fakeCredentials()

    const outcome = await createOfflinePasskey({ label: 'Notes', credentials })

    const salt = prfSaltOf(createdPublicKey(credentials))
    expect(salt.byteLength).toBe(32)
    if (!outcome.ok) throw new Error('expected a created passkey')
    expect(outcome.record).toEqual({
      credentialId: bytesToBase64Url(RAW_ID),
      prfSalt: bytesToBase64Url(salt),
    })
    expect(base64UrlToBytes(outcome.record.prfSalt)).toEqual(salt)
    expect(outcome.prfOutput).toEqual(PRF_OUTPUT)
  })

  it('draws a fresh challenge, user id and salt on every call', async () => {
    const credentials = fakeCredentials()

    await createOfflinePasskey({ label: 'Notes', credentials })
    await createOfflinePasskey({ label: 'Notes', credentials })

    const [first, second] = [createdPublicKey(credentials, 0), createdPublicKey(credentials, 1)]
    const bytes = (value: BufferSource): Uint8Array => new Uint8Array(value as ArrayBuffer)
    expect(bytes(first.challenge).byteLength).toBe(32)
    expect(bytes(first.challenge)).not.toEqual(bytes(second.challenge))
    expect(bytes(first.user.id).byteLength).toBe(16)
    expect(bytes(first.user.id)).not.toEqual(bytes(second.user.id))
    expect(prfSaltOf(first)).not.toEqual(prfSaltOf(second))
  })

  it('answers unsupported without prompting when there is no WebAuthn', async () => {
    expect(await createOfflinePasskey({ label: 'Notes', credentials: undefined })).toEqual({
      ok: false,
      reason: 'unsupported',
    })
  })

  describe('the browser capability probe', () => {
    function stubCapabilities(probe: () => Promise<Record<string, boolean>>): void {
      vi.stubGlobal('PublicKeyCredential', { getClientCapabilities: probe })
    }

    it('answers unsupported, creating nothing, when the browser says it has no prf', async () => {
      stubCapabilities(async () => ({ 'extension:prf': false }))
      const credentials = fakeCredentials()

      const outcome = await createOfflinePasskey({ label: 'Notes', credentials })

      expect(outcome).toEqual({ ok: false, reason: 'unsupported' })
      expect(credentials.create).not.toHaveBeenCalled()
    })

    it.each([
      ['says it has prf', async () => ({ 'extension:prf': true })],
      ['does not mention prf', async () => ({})],
      [
        'fails to answer',
        async (): Promise<Record<string, boolean>> => {
          throw new Error('probe failed')
        },
      ],
    ])('lets the authenticator decide at creation when the browser %s', async (_name, probe) => {
      stubCapabilities(probe)
      const credentials = fakeCredentials()

      const outcome = await createOfflinePasskey({ label: 'Notes', credentials })

      expect(outcome.ok).toBe(true)
      expect(credentials.create).toHaveBeenCalledTimes(1)
    })
  })

  describe('when the prompt does not produce a credential', () => {
    it.each([
      'NotAllowedError',
      'AbortError',
    ])('reads a %s as the person declining', async (name) => {
      const credentials = fakeCredentials({
        create: vi.fn(async () => {
          throw namedError(name)
        }),
      })

      expect(await createOfflinePasskey({ label: 'Notes', credentials })).toEqual({
        ok: false,
        reason: 'cancelled',
      })
    })

    it.each([
      ['an error of another name', namedError('NotSupportedError')],
      ['something that is not an error at all', 'NotAllowedError'],
    ])('does not read %s as the person declining', async (_name, thrown) => {
      const credentials = fakeCredentials({
        create: vi.fn(async () => {
          throw thrown
        }),
      })

      expect(await createOfflinePasskey({ label: 'Notes', credentials })).toEqual({
        ok: false,
        reason: 'unsupported',
      })
    })

    it('reads a null credential as the person declining', async () => {
      const credentials = fakeCredentials({ create: vi.fn(async () => null) })

      expect(await createOfflinePasskey({ label: 'Notes', credentials })).toEqual({
        ok: false,
        reason: 'cancelled',
      })
    })
  })

  describe('an authenticator that only enables prf at creation', () => {
    it('asserts once for the output, with the credential it just made', async () => {
      const credentials = fakeCredentials({ create: vi.fn(async () => enabledOnly()) })

      const outcome = await createOfflinePasskey({ label: 'Notes', credentials })

      expect(outcome.ok).toBe(true)
      expect(credentials.get).toHaveBeenCalledTimes(1)
      const asked = requestedPublicKey(credentials)
      expect(new Uint8Array(asked.allowCredentials?.[0]?.id as ArrayBuffer)).toEqual(RAW_ID)
      expect(prfSaltOf(asked)).toEqual(prfSaltOf(createdPublicKey(credentials)))
    })

    it('says the authenticator cannot do it, without a second prompt, when prf is not enabled', async () => {
      const credentials = fakeCredentials({
        create: vi.fn(async () => credentialWith({ prf: { enabled: false } })),
      })

      const outcome = await createOfflinePasskey({ label: 'Notes', credentials })

      expect(outcome).toEqual({ ok: false, reason: 'unsupported' })
      expect(credentials.get).not.toHaveBeenCalled()
    })

    it('says the authenticator cannot do it, without a second prompt, when it reports nothing', async () => {
      const credentials = fakeCredentials({ create: vi.fn(async () => credentialWith({})) })

      const outcome = await createOfflinePasskey({ label: 'Notes', credentials })

      expect(outcome).toEqual({ ok: false, reason: 'unsupported' })
      expect(credentials.get).not.toHaveBeenCalled()
    })

    it('says the person declined when they decline the second prompt', async () => {
      const credentials = fakeCredentials({
        create: vi.fn(async () => enabledOnly()),
        get: vi.fn(async () => {
          throw namedError('NotAllowedError')
        }),
      })

      expect(await createOfflinePasskey({ label: 'Notes', credentials })).toEqual({
        ok: false,
        reason: 'cancelled',
      })
    })

    it('says the authenticator cannot do it when the second prompt yields no output', async () => {
      const credentials = fakeCredentials({
        create: vi.fn(async () => enabledOnly()),
        get: vi.fn(async () => credentialWith({})),
      })

      expect(await createOfflinePasskey({ label: 'Notes', credentials })).toEqual({
        ok: false,
        reason: 'unsupported',
      })
    })
  })
})

describe('assertOfflinePasskey', () => {
  it('asks for user verification with this credential and salt, on a fresh 32-byte challenge', async () => {
    const credentials = fakeCredentials()

    await assertOfflinePasskey(RECORD, credentials)
    await assertOfflinePasskey(RECORD, credentials)

    const [first, second] = [requestedPublicKey(credentials, 0), requestedPublicKey(credentials, 1)]
    expect(first.userVerification).toBe('required')
    expect(first.allowCredentials).toHaveLength(1)
    expect(first.allowCredentials?.[0]?.type).toBe('public-key')
    expect(new Uint8Array(first.allowCredentials?.[0]?.id as ArrayBuffer)).toEqual(RAW_ID)
    expect(prfSaltOf(first)).toEqual(PRF_OUTPUT)
    const bytes = (value: BufferSource): Uint8Array => new Uint8Array(value as ArrayBuffer)
    expect(bytes(first.challenge).byteLength).toBe(32)
    expect(bytes(first.challenge)).not.toEqual(bytes(second.challenge))
  })

  it('answers the prf output the authenticator evaluated', async () => {
    expect(await assertOfflinePasskey(RECORD, fakeCredentials())).toEqual({
      ok: true,
      prfOutput: PRF_OUTPUT,
    })
  })

  it('answers no-passkey when there is no WebAuthn', async () => {
    expect(await assertOfflinePasskey(RECORD, undefined)).toEqual({
      ok: false,
      reason: 'no-passkey',
    })
  })

  it('answers cancelled, asking nothing, for a record that does not decode', async () => {
    const credentials = fakeCredentials()

    expect(await assertOfflinePasskey({ ...RECORD, prfSalt: 'A' }, credentials)).toEqual({
      ok: false,
      reason: 'cancelled',
    })
    expect(await assertOfflinePasskey({ ...RECORD, credentialId: 'A' }, credentials)).toEqual({
      ok: false,
      reason: 'cancelled',
    })
    expect(credentials.get).not.toHaveBeenCalled()
  })

  it('answers cancelled when the prompt is refused, whatever the refusal', async () => {
    for (const thrown of [namedError('NotAllowedError'), namedError('SecurityError')]) {
      const credentials = fakeCredentials({
        get: vi.fn(async () => {
          throw thrown
        }),
      })

      expect(await assertOfflinePasskey(RECORD, credentials)).toEqual({
        ok: false,
        reason: 'cancelled',
      })
    }
  })

  it('answers cancelled, rather than throwing, when the prompt yields no credential', async () => {
    const credentials = fakeCredentials({ get: vi.fn(async () => null) })

    expect(await assertOfflinePasskey(RECORD, credentials)).toEqual({
      ok: false,
      reason: 'cancelled',
    })
  })

  it('answers no-prf for an assertion that carried no key material', async () => {
    const credentials = fakeCredentials({ get: vi.fn(async () => credentialWith({})) })

    expect(await assertOfflinePasskey(RECORD, credentials)).toEqual({
      ok: false,
      reason: 'no-prf',
    })
  })
})
