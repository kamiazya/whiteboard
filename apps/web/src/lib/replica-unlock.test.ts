/**
 * The cold start itself (ADR-0042 decision 6): a replica this browser
 * already holds, opened from disk by one passkey gesture, with the daemon
 * unreachable.
 *
 * What these cases hold is that every way it can fail says which — and that
 * the two failures which can never resolve on their own (a blob no
 * authenticator here can open, a lease already spent) take the blob with
 * them rather than leaving an unopenable artefact on disk.
 */

import { adoptSessionKey, forgetAll } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PasskeyCredentials } from './passkey-attestation.js'
import { prfInputForDaemon } from './passkey-prf.js'
import { rememberReplicaKey, unlockReplicaKey } from './replica-unlock.js'
import { loadWrappedKey, saveWrappedKey } from './replica-wrapped-key-store.js'

const DAEMON = 'http://127.0.0.1:3099'
const WORKSPACE = 'ws-1'
const PRF = new Uint8Array(32).fill(7)
const OTHER_PRF = new Uint8Array(32).fill(9)

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

const RESPONSE = {
  workspaceKey: base64Url(Uint8Array.from({ length: 32 }, (_, i) => i + 1)),
  workspaceKeySalt: base64Url(Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i)),
  tier: 'offline' as const,
}

function storageWithPasskey(): Storage {
  const map = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  }
  storage.setItem(
    'whiteboard:daemon-passkeys',
    JSON.stringify({
      [DAEMON]: { credentialId: 'AQIDBA', registeredAt: '2026-09-21T00:00:00Z' },
    }),
  )
  return storage
}

/** Credentials whose assertion carries `prf`, or carries nothing when `prf` is undefined. */
function credentialsYielding(prf?: Uint8Array): PasskeyCredentials {
  return {
    create: async () => null,
    get: async () =>
      ({
        rawId: new Uint8Array([1, 2, 3, 4]).buffer,
        response: {
          authenticatorData: new Uint8Array([9]).buffer,
          clientDataJSON: new Uint8Array([8]).buffer,
          signature: new Uint8Array([7]).buffer,
        },
        getClientExtensionResults: () =>
          (prf === undefined ? {} : { prf: { results: { first: prf.buffer } } }) as never,
      }) as unknown as PublicKeyCredential,
  }
}

beforeEach(() => {
  localStorage.removeItem('whiteboard:replica-sealed-keys')
  forgetAll()
})

afterEach(() => {
  forgetAll()
})

describe('rememberReplicaKey', () => {
  it('leaves a blob this device can open again', async () => {
    await rememberReplicaKey({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      response: RESPONSE,
      prfOutput: PRF,
    })

    const stored = loadWrappedKey(DAEMON, WORKSPACE)
    expect(stored).not.toBeNull()
    // Ciphertext, not the key: whatever later owns this origin holds nothing.
    expect(JSON.stringify(stored)).not.toContain(RESPONSE.workspaceKey)
  })
})

describe('unlockReplicaKey', () => {
  it('opens a remembered replica and holds its key, with no daemon in reach', async () => {
    await rememberReplicaKey({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      response: RESPONSE,
      prfOutput: PRF,
    })

    const outcome = await unlockReplicaKey({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      credentials: credentialsYielding(PRF),
      storage: storageWithPasskey(),
    })

    expect(outcome).toEqual({ ok: true, tier: 'offline' })
  })

  it('asks the authenticator for the daemon-derived prf input, on one assertion', async () => {
    await rememberReplicaKey({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      response: RESPONSE,
      prfOutput: PRF,
    })
    const credentials = credentialsYielding(PRF)
    const get = vi.spyOn(credentials, 'get')

    await unlockReplicaKey({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      credentials,
      storage: storageWithPasskey(),
    })

    // ONE prompt, verifying the person and yielding the key material at once.
    expect(get).toHaveBeenCalledTimes(1)
    const asked = get.mock.calls[0]?.[0]?.publicKey
    expect(asked?.userVerification).toBe('required')
    expect(new Uint8Array(asked?.extensions?.prf?.eval?.first as ArrayBuffer)).toEqual(
      await prfInputForDaemon(DAEMON),
    )
  })

  it('says there is nothing remembered rather than prompting for a passkey', async () => {
    const credentials = credentialsYielding(PRF)
    const get = vi.spyOn(credentials, 'get')

    const outcome = await unlockReplicaKey({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      credentials,
      storage: storageWithPasskey(),
    })

    // Prompting when there is nothing to open teaches a person the gesture
    // is meaningless.
    expect(outcome).toEqual({ ok: false, reason: 'no-blob' })
    expect(get).not.toHaveBeenCalled()
  })

  it('reports an authenticator that produced no key material, without losing the blob', async () => {
    await rememberReplicaKey({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      response: RESPONSE,
      prfOutput: PRF,
    })

    const outcome = await unlockReplicaKey({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      credentials: credentialsYielding(undefined),
      storage: storageWithPasskey(),
    })

    // A browser without the extension is a browser, not a verdict: another
    // one on this machine may still open it.
    expect(outcome).toEqual({ ok: false, reason: 'no-prf' })
    expect(loadWrappedKey(DAEMON, WORKSPACE)).not.toBeNull()
  })

  it('drops a blob no authenticator here can open', async () => {
    await rememberReplicaKey({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      response: RESPONSE,
      prfOutput: PRF,
    })

    const outcome = await unlockReplicaKey({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      credentials: credentialsYielding(OTHER_PRF),
      storage: storageWithPasskey(),
    })

    // Ciphertext nothing on this device can read is not a copy, it is
    // debris — and keeping it offers an unlock that can never succeed.
    expect(outcome).toEqual({ ok: false, reason: 'unopenable' })
    expect(loadWrappedKey(DAEMON, WORKSPACE)).toBeNull()
  })

  it('drops a blob whose bounded lease has already passed', async () => {
    await rememberReplicaKey({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      response: {
        ...RESPONSE,
        tier: 'bounded',
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      },
      prfOutput: PRF,
    })

    const outcome = await unlockReplicaKey({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      credentials: credentialsYielding(PRF),
      storage: storageWithPasskey(),
    })

    expect(outcome).toEqual({ ok: false, reason: 'lapsed' })
    expect(loadWrappedKey(DAEMON, WORKSPACE)).toBeNull()
  })

  it('says no passkey when this daemon has none registered', async () => {
    saveWrappedKey(DAEMON, WORKSPACE, { v: 1, iv: 'AAECAwQFBgcICQoL', ct: 'DA0ODxAREhMUFRYX' })

    const outcome = await unlockReplicaKey({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      credentials: credentialsYielding(PRF),
      storage: localStorage,
    })

    expect(outcome).toEqual({ ok: false, reason: 'no-passkey' })
  })

  it('reports a key this session already holds as open, without a prompt', async () => {
    await rememberReplicaKey({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      response: RESPONSE,
      prfOutput: PRF,
    })
    adoptSessionKey(DAEMON, WORKSPACE, RESPONSE)
    const credentials = credentialsYielding(PRF)
    const get = vi.spyOn(credentials, 'get')

    const outcome = await unlockReplicaKey({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      credentials,
      storage: storageWithPasskey(),
    })

    // Asking someone to prove themselves for something already open is the
    // prompt this whole design exists to avoid.
    expect(outcome).toEqual({ ok: true, tier: 'offline' })
    expect(get).not.toHaveBeenCalled()
  })
})
