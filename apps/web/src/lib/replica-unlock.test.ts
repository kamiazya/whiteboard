/**
 * The cold start itself (ADR-0042 decision 6): a replica this browser
 * already holds, opened from disk by one gesture of the passkey kept for it
 * in this browser (ADR-0050 decision 11), with the daemon unreachable.
 *
 * What these cases hold is that every way it can fail says which — and that
 * the two failures which can never resolve on their own (a blob no
 * authenticator here can open, a lease already spent) take the blob with
 * them rather than leaving an unopenable artefact on disk.
 */

import {
  adoptSessionKey,
  forgetAllForTests,
} from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import { bytesToBase64Url } from '@kamiazya/whiteboard-model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type OfflinePasskeyCredentials, saveOfflinePasskey } from './replica-offline-passkey.js'
import { rememberReplicaKey, unlockReplicaKey } from './replica-unlock.js'
import { loadWrappedKey, saveWrappedKey } from './replica-wrapped-key-store.js'

const DAEMON = 'http://127.0.0.1:3099'
const WORKSPACE = 'ws-1'
const PRF = new Uint8Array(32).fill(7)
const OTHER_PRF = new Uint8Array(32).fill(9)

const RESPONSE = {
  workspaceKey: bytesToBase64Url(Uint8Array.from({ length: 32 }, (_, i) => i + 1)),
  workspaceKeySalt: bytesToBase64Url(Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i)),
  tier: 'offline' as const,
}

/** The passkey this browser keeps for the copy, as Settings' opt-in leaves it. */
const OFFLINE_PASSKEY = { credentialId: 'AQIDBA', prfSalt: 'BQYHCA' }

function keepOfflinePasskey(): void {
  saveOfflinePasskey(DAEMON, WORKSPACE, OFFLINE_PASSKEY)
}

/** Credentials whose assertion carries `prf`, or carries nothing when `prf` is undefined. */
function credentialsYielding(prf?: Uint8Array): OfflinePasskeyCredentials {
  return {
    create: async () => null,
    get: async () =>
      ({
        rawId: new Uint8Array([1, 2, 3, 4]).buffer,
        getClientExtensionResults: () =>
          (prf === undefined ? {} : { prf: { results: { first: prf.buffer } } }) as never,
      }) as unknown as PublicKeyCredential,
  }
}

beforeEach(() => {
  localStorage.clear()
  forgetAllForTests()
  keepOfflinePasskey()
})

afterEach(() => {
  forgetAllForTests()
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
    })

    expect(outcome).toEqual({ ok: true, tier: 'offline' })
  })

  it('asks the passkey kept for this copy, with its own salt, on one assertion', async () => {
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
    })

    // ONE prompt, verifying the person and yielding the key material at once.
    expect(get).toHaveBeenCalledTimes(1)
    const asked = get.mock.calls[0]?.[0]?.publicKey
    expect(asked?.userVerification).toBe('required')
    expect(new Uint8Array(asked?.allowCredentials?.[0]?.id as ArrayBuffer)).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    )
    expect(new Uint8Array(asked?.extensions?.prf?.eval?.first as ArrayBuffer)).toEqual(
      new Uint8Array([5, 6, 7, 8]),
    )
  })

  it('says there is nothing remembered rather than prompting for a passkey', async () => {
    const credentials = credentialsYielding(PRF)
    const get = vi.spyOn(credentials, 'get')

    const outcome = await unlockReplicaKey({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      credentials,
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
    })

    expect(outcome).toEqual({ ok: false, reason: 'lapsed' })
    expect(loadWrappedKey(DAEMON, WORKSPACE)).toBeNull()
  })

  it('drops a blob no passkey in this browser was kept for, without prompting', async () => {
    localStorage.clear()
    saveWrappedKey(DAEMON, WORKSPACE, { v: 1, iv: 'AAECAwQFBgcICQoL', ct: 'DA0ODxAREhMUFRYX' })
    const credentials = credentialsYielding(PRF)
    const get = vi.spyOn(credentials, 'get')

    const outcome = await unlockReplicaKey({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      credentials,
    })

    // A copy wrapped under a passkey a daemon's pairing once registered has
    // nothing left here that can open it.
    expect(outcome).toEqual({ ok: false, reason: 'unopenable' })
    expect(get).not.toHaveBeenCalled()
    expect(loadWrappedKey(DAEMON, WORKSPACE)).toBeNull()
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
    })

    // Asking someone to prove themselves for something already open is the
    // prompt this whole design exists to avoid.
    expect(outcome).toEqual({ ok: true, tier: 'offline' })
    expect(get).not.toHaveBeenCalled()
  })
})
