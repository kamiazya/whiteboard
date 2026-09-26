import { promotionChallengeInput } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { describe, expect, it, vi } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import {
  attestPromotion,
  forgetRegisteredPasskey,
  getRegisteredPasskey,
  type PasskeyCredentials,
  passkeySupported,
  promotionChallenge,
  registerPasskey,
} from './passkey-attestation.js'

const DAEMON = 'http://127.0.0.1:3099'

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

const RAW_ID = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
const SPKI = Uint8Array.from([48, 89, 48, 19])
const AUTH_DATA = Uint8Array.from({ length: 37 }, (_, i) => i)

/** A registration as the platform hands it back: rawId, SPKI, and authenticatorData. */
function attestationCredential(): Credential {
  return {
    id: b64u(RAW_ID),
    type: 'public-key',
    rawId: RAW_ID.buffer,
    response: {
      getPublicKey: () => SPKI.buffer,
      getAuthenticatorData: () => AUTH_DATA.buffer,
    },
  } as unknown as Credential
}

function assertionCredential(parts: { auth: Uint8Array; client: Uint8Array; sig: Uint8Array }) {
  return {
    id: b64u(RAW_ID),
    type: 'public-key',
    rawId: RAW_ID.buffer,
    response: {
      authenticatorData: parts.auth.buffer,
      clientDataJSON: parts.client.buffer,
      signature: parts.sig.buffer,
    },
  } as unknown as Credential
}

function daemonAccepting(
  calls: { url: string; init: RequestInit }[],
  status = 201,
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    if (status !== 201)
      return Response.json({ error: 'registration_rejected', message: 'rpIdHash' }, { status })
    return Response.json(
      {
        credentialId: b64u(RAW_ID),
        origin: 'http://localhost:5173',
        backupEligible: true,
        createdAt: '2026-09-16T00:00:00.000Z',
      },
      { status: 201 },
    )
  }) as typeof globalThis.fetch
}

describe('registerPasskey', () => {
  it('asks for an ES256, user-verified passkey, pins its SPKI and authenticatorData on the daemon, and remembers the id per daemon', async () => {
    const created: CredentialCreationOptions[] = []
    const credentials: PasskeyCredentials = {
      create: async (options) => {
        created.push(options)
        return attestationCredential()
      },
      get: async () => null,
    }
    const calls: { url: string; init: RequestInit }[] = []
    const storage = memoryStorage()

    const result = await registerPasskey({
      daemonBaseUrl: `${DAEMON}/`,
      fetch: daemonAccepting(calls),
      credentials,
      storage,
    })

    expect(result).toEqual({ ok: true, credentialId: b64u(RAW_ID), backupEligible: true })
    const publicKey = created[0]?.publicKey
    expect(publicKey?.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }])
    expect(publicKey?.authenticatorSelection?.userVerification).toBe('required')
    expect(publicKey?.attestation).toBe('none')
    // The relying party is the page's own origin: no rp.id is set.
    expect(publicKey?.rp).toEqual({ name: 'Whiteboard' })
    expect((publicKey?.challenge as Uint8Array | undefined)?.byteLength).toBe(32)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${DAEMON}/api/pairing/credentials`)
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      credentialId: b64u(RAW_ID),
      publicKey: b64u(SPKI),
      authenticatorData: b64u(AUTH_DATA),
    })
    // Keyed without the trailing slash, so both spellings find it.
    expect(getRegisteredPasskey(DAEMON, storage)).toEqual({
      credentialId: b64u(RAW_ID),
      registeredAt: '2026-09-16T00:00:00.000Z',
    })
  })

  it('names each way a registration can fail, and stores nothing on any of them', async () => {
    const storage = memoryStorage()
    const calls: { url: string; init: RequestInit }[] = []
    const base = { daemonBaseUrl: DAEMON, fetch: daemonAccepting(calls), storage }
    const cancel = Object.assign(new Error('cancelled'), { name: 'NotAllowedError' })

    expect(await registerPasskey({ ...base, credentials: undefined })).toEqual({
      ok: false,
      reason: 'unsupported',
    })
    expect(
      await registerPasskey({
        ...base,
        credentials: { create: async () => Promise.reject(cancel), get: async () => null },
      }),
    ).toEqual({ ok: false, reason: 'cancelled' })
    // A browser without getPublicKey() cannot hand the daemon a key it can read.
    const noSpki = { ...attestationCredential(), response: {} } as unknown as Credential
    expect(
      await registerPasskey({
        ...base,
        credentials: { create: async () => noSpki, get: async () => null },
      }),
    ).toEqual({ ok: false, reason: 'unsupported' })
    // The daemon refused: its reason travels.
    expect(
      await registerPasskey({
        ...base,
        fetch: daemonAccepting(calls, 400),
        credentials: { create: async () => attestationCredential(), get: async () => null },
      }),
    ).toEqual({ ok: false, reason: 'rejected', detail: 'rpIdHash' })
    expect(
      await registerPasskey({
        ...base,
        fetch: (async () => {
          throw new TypeError('Failed to fetch')
        }) as typeof globalThis.fetch,
        credentials: { create: async () => attestationCredential(), get: async () => null },
      }),
    ).toMatchObject({ ok: false, reason: 'unreachable' })
    // A 2xx whose body is not the contract is a refusal to store, not a throw:
    // the caller has already shown "waiting", and a rejection would leave it there.
    expect(
      await registerPasskey({
        ...base,
        fetch: (async () => new Response('', { status: 201 })) as typeof globalThis.fetch,
        credentials: { create: async () => attestationCredential(), get: async () => null },
      }),
    ).toEqual({ ok: false, reason: 'rejected', detail: 'malformed response' })
    expect(getRegisteredPasskey(DAEMON, storage)).toBeNull()
  })
})

describe('forgetRegisteredPasskey', () => {
  it('drops this daemon and leaves every other one', async () => {
    const storage = memoryStorage()
    storage.setItem(
      'whiteboard:daemon-passkeys',
      JSON.stringify({
        [DAEMON]: { credentialId: b64u(RAW_ID), registeredAt: 'x' },
        'http://127.0.0.1:4000': { credentialId: 'b3RoZXI', registeredAt: 'y' },
      }),
    )

    forgetRegisteredPasskey(`${DAEMON}/`, storage)

    expect(getRegisteredPasskey(DAEMON, storage)).toBeNull()
    expect(getRegisteredPasskey('http://127.0.0.1:4000', storage)?.credentialId).toBe('b3RoZXI')
  })

  it('is a no-op where nothing is registered', () => {
    const storage = memoryStorage()
    forgetRegisteredPasskey(DAEMON, storage)
    expect(getRegisteredPasskey(DAEMON, storage)).toBeNull()
  })
})

describe('attestPromotion', () => {
  const snapshot = Uint8Array.from([9, 8, 7, 6, 5])

  it('answers null when no passkey is registered for this daemon', async () => {
    const get = vi.fn()
    expect(
      await attestPromotion({
        daemonBaseUrl: DAEMON,
        workspaceId: 'ws-1',
        snapshot,
        credentials: { create: async () => null, get },
        storage: memoryStorage(),
      }),
    ).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })

  it('a stored id that is not base64url reads as no passkey, so the move goes on without one', async () => {
    const storage = memoryStorage()
    storage.setItem(
      'whiteboard:daemon-passkeys',
      JSON.stringify({ [DAEMON]: { credentialId: '%', registeredAt: 'x' } }),
    )
    const get = vi.fn()
    expect(getRegisteredPasskey(DAEMON, storage)).toBeNull()
    expect(
      await attestPromotion({
        daemonBaseUrl: DAEMON,
        workspaceId: 'ws-1',
        snapshot,
        credentials: { create: async () => null, get },
        storage,
      }),
    ).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })

  it('signs the daemon-recomputable challenge with the registered credential and returns the wire attestation', async () => {
    const storage = memoryStorage()
    const calls: { url: string; init: RequestInit }[] = []
    await registerPasskey({
      daemonBaseUrl: DAEMON,
      fetch: daemonAccepting(calls),
      credentials: { create: async () => attestationCredential(), get: async () => null },
      storage,
    })
    const parts = {
      auth: Uint8Array.from({ length: 37 }, (_, i) => 37 - i),
      client: new TextEncoder().encode('{"type":"webauthn.get"}'),
      sig: Uint8Array.from([70, 71, 72]),
    }
    const requested: CredentialRequestOptions[] = []
    const outcome = await attestPromotion({
      daemonBaseUrl: DAEMON,
      workspaceId: 'ws-1',
      snapshot,
      credentials: {
        create: async () => null,
        get: async (options) => {
          requested.push(options)
          return assertionCredential(parts)
        },
      },
      storage,
    })

    expect(outcome).toEqual({
      ok: true,
      attestation: {
        kind: 'webauthn',
        credentialId: b64u(RAW_ID),
        authenticatorData: b64u(parts.auth),
        clientDataJSON: b64u(parts.client),
        signature: b64u(parts.sig),
      },
    })
    const publicKey = requested[0]?.publicKey
    expect(publicKey?.userVerification).toBe('required')
    expect(new Uint8Array(publicKey?.allowCredentials?.[0]?.id as ArrayBuffer)).toEqual(RAW_ID)
    // The challenge the daemon recomputes: SHA-256 over the shared input,
    // which carries the target handle and the snapshot's own digest.
    const snapshotDigest = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', snapshot)))
    const expected = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        promotionChallengeInput({ workspaceId: 'ws-1', snapshotDigest }) as BufferSource,
      ),
    )
    expect(new Uint8Array(publicKey?.challenge as ArrayBuffer)).toEqual(expected)
  })

  it('a cancelled prompt is reported as cancelled, not as an assertion', async () => {
    const storage = memoryStorage()
    await registerPasskey({
      daemonBaseUrl: DAEMON,
      fetch: daemonAccepting([]),
      credentials: { create: async () => attestationCredential(), get: async () => null },
      storage,
    })
    const cancel = Object.assign(new Error('cancelled'), { name: 'NotAllowedError' })
    expect(
      await attestPromotion({
        daemonBaseUrl: DAEMON,
        workspaceId: 'ws-1',
        snapshot,
        credentials: { create: async () => null, get: async () => Promise.reject(cancel) },
        storage,
      }),
    ).toEqual({ ok: false, reason: 'cancelled' })
  })

  fcTest.prop(
    [fc.string({ minLength: 1, maxLength: 40 }), fc.uint8Array({ minLength: 0, maxLength: 256 })],
    withDefaults({ numRuns: 40 }),
  )('the challenge is a function of the handle and the bytes alone', async (workspaceId, bytes) => {
    const a = await promotionChallenge(workspaceId, bytes)
    const b = await promotionChallenge(workspaceId, Uint8Array.from(bytes))
    expect(a).toEqual(b)
    expect(a.byteLength).toBe(32)
    // One byte more, or another handle, and it is another challenge.
    const other = await promotionChallenge(`${workspaceId}x`, bytes)
    expect(other).not.toEqual(a)
  })
})

describe('passkeySupported', () => {
  it('needs both the credential API and PublicKeyCredential', () => {
    expect(passkeySupported({})).toBe(false)
    expect(passkeySupported({ PublicKeyCredential: class {}, navigator: {} })).toBe(false)
    expect(
      passkeySupported({ PublicKeyCredential: class {}, navigator: { credentials: {} } }),
    ).toBe(true)
  })
})

describe('a passkey store holding an entry this build cannot read', () => {
  it('still answers the entries it can read', () => {
    const storage = memoryStorage()
    const credentialId = b64u(RAW_ID)
    storage.setItem(
      'whiteboard:daemon-passkeys',
      JSON.stringify({
        'http://127.0.0.1:3099': { credentialId, registeredAt: '2026-09-01T00:00:00.000Z' },
        'http://127.0.0.1:4000': {
          credentialId,
          registeredAt: '2026-09-01T00:00:00.000Z',
          addedByANewerBuild: true,
        },
      }),
    )
    expect(getRegisteredPasskey('http://127.0.0.1:3099', storage)?.credentialId).toBe(credentialId)
  })
})
