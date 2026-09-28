import { promotionChallengeInput } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { describe, expect, it, vi } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { attestPromotion, promotionChallenge } from './passkey-attestation.js'

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

/** Leaves a passkey registered for DAEMON the way a keeper's registration did. */
function storageWithPasskey(): ReturnType<typeof memoryStorage> {
  const storage = memoryStorage()
  storage.setItem(
    'whiteboard:daemon-passkeys',
    JSON.stringify({ [DAEMON]: { credentialId: b64u(RAW_ID), registeredAt: 'x' } }),
  )
  return storage
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
    const storage = storageWithPasskey()
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
    const storage = storageWithPasskey()
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

describe('a passkey store holding an entry this build cannot read', () => {
  it('still answers the entries it can read', async () => {
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
    const requested: CredentialRequestOptions[] = []
    await attestPromotion({
      daemonBaseUrl: 'http://127.0.0.1:3099',
      workspaceId: 'ws-1',
      snapshot: Uint8Array.from([1]),
      credentials: {
        create: async () => null,
        get: async (options) => {
          requested.push(options)
          return null
        },
      },
      storage,
    })
    expect(
      new Uint8Array(requested[0]?.publicKey?.allowCredentials?.[0]?.id as ArrayBuffer),
    ).toEqual(RAW_ID)
  })
})
