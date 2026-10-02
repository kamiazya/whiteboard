/**
 * Making a daemon-kept copy readable offline from Settings (ADR-0050
 * decision 11): a passkey created in THIS browser only, whose `prf` output
 * wraps the copy's key, and which the existing unlock then opens with no
 * daemon in reach and no passkey registered with any daemon.
 *
 * The authenticator double derives its `prf` output from the credential and
 * the salt it is asked with, the way a real one does — so a test that passed
 * the wrong salt, or asserted with the wrong credential, would derive a
 * different key and open nothing.
 */

import { forgetAllForTests } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import { bytesToBase64Url } from '@kamiazya/whiteboard-model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import {
  assertOfflinePasskey,
  loadOfflinePasskey,
  type OfflinePasskeyCredentials,
} from './replica-offline-passkey.js'
import {
  isReplicaReadableOffline,
  makeReplicaReadableOffline,
  stopReplicaReadableOffline,
  unlockReplicaKey,
} from './replica-unlock.js'
import { loadWrappedKey } from './replica-wrapped-key-store.js'

const DAEMON = 'https://daemon.whiteboard.invalid'
const WORKSPACE = 'ws-1'

const RESPONSE = {
  workspaceKey: bytesToBase64Url(Uint8Array.from({ length: 32 }, (_, i) => i + 1)),
  workspaceKeySalt: bytesToBase64Url(Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i)),
  tier: 'offline' as const,
}

function daemonAnswering(body: unknown = RESPONSE): typeof globalThis.fetch {
  return vi.fn(async () => jsonResponse(body))
}

const unreachable: typeof globalThis.fetch = vi.fn(async () => {
  throw new TypeError('Failed to fetch')
})

const CREDENTIAL_ID = new Uint8Array([5, 6, 7, 8])

/** What an authenticator's prf does: a stable function of (credential, salt). */
async function prfOf(credentialId: Uint8Array, salt: Uint8Array): Promise<ArrayBuffer> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array([...credentialId, ...salt]))
  // Copied into this realm's ArrayBuffer: jsdom's global is not Node's, and
  // `prfOutputOf` checks the type the way a real browser hands it over.
  return new Uint8Array(digest).slice().buffer
}

function extensionSalt(options: CredentialCreationOptions | CredentialRequestOptions) {
  const first = (
    options.publicKey?.extensions as { prf?: { eval?: { first?: BufferSource } } } | undefined
  )?.prf?.eval?.first
  return first === undefined ? undefined : new Uint8Array(first as ArrayBuffer)
}

function credentialAnswering(prfResults: unknown): PublicKeyCredential {
  return {
    rawId: CREDENTIAL_ID.buffer,
    getClientExtensionResults: () => ({ prf: prfResults }) as never,
  } as unknown as PublicKeyCredential
}

/**
 * An authenticator with prf. `evalAtCreate: false` is one that only enables
 * the extension at creation and evaluates it on assertion — both shapes ship.
 */
function authenticator({
  evalAtCreate = true,
  prf = true,
}: {
  evalAtCreate?: boolean
  prf?: boolean
} = {}): OfflinePasskeyCredentials {
  return {
    create: vi.fn(async (options?: CredentialCreationOptions) => {
      const salt = extensionSalt(options ?? {})
      if (!prf) return credentialAnswering({ enabled: false })
      if (!evalAtCreate || salt === undefined) return credentialAnswering({ enabled: true })
      return credentialAnswering({
        enabled: true,
        results: { first: await prfOf(CREDENTIAL_ID, salt) },
      })
    }),
    get: vi.fn(async (options?: CredentialRequestOptions) => {
      const allowed = options?.publicKey?.allowCredentials?.[0]?.id as ArrayBuffer | undefined
      const salt = extensionSalt(options ?? {})
      if (!prf || allowed === undefined || salt === undefined) return credentialAnswering({})
      return credentialAnswering({
        results: { first: await prfOf(new Uint8Array(allowed), salt) },
      })
    }),
  }
}

beforeEach(() => {
  localStorage.clear()
  forgetAllForTests()
})

afterEach(() => {
  forgetAllForTests()
})

describe('makeReplicaReadableOffline', () => {
  it('wraps the copy under a passkey kept in this browser, which the unlock then opens', async () => {
    const credentials = authenticator()

    const made = await makeReplicaReadableOffline({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      label: 'Notes',
      fetch: daemonAnswering(),
      credentials,
    })

    expect(made).toEqual({ ok: true })
    expect(isReplicaReadableOffline(DAEMON, WORKSPACE)).toBe(true)
    // Ciphertext, not the key.
    expect(JSON.stringify(loadWrappedKey(DAEMON, WORKSPACE))).not.toContain(RESPONSE.workspaceKey)

    // No daemon, and no passkey registered with one: only the local credential.
    const unlocked = await unlockReplicaKey({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      credentials,
    })
    expect(unlocked).toEqual({ ok: true, tier: 'offline' })
  })

  it('asserts with the stored credential and salt, on one prompt', async () => {
    const credentials = authenticator()
    await makeReplicaReadableOffline({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      label: 'Notes',
      fetch: daemonAnswering(),
      credentials,
    })
    const stored = loadOfflinePasskey(DAEMON, WORKSPACE)
    vi.mocked(credentials.get).mockClear()

    await unlockReplicaKey({ daemonBaseUrl: DAEMON, workspaceId: WORKSPACE, credentials })

    expect(credentials.get).toHaveBeenCalledTimes(1)
    const asked = vi.mocked(credentials.get).mock.calls[0]?.[0]?.publicKey
    expect(asked?.userVerification).toBe('required')
    expect(bytesToBase64Url(new Uint8Array(asked?.allowCredentials?.[0]?.id as ArrayBuffer))).toBe(
      stored?.credentialId,
    )
    expect(bytesToBase64Url(extensionSalt({ publicKey: asked }) as Uint8Array)).toBe(
      stored?.prfSalt,
    )
  })

  it('treats a stored record that is not base64url as no usable credential, and asks nothing', async () => {
    const credentials = authenticator()

    // One character is not a whole byte, so it names nothing to ask for.
    const outcome = await assertOfflinePasskey({ credentialId: 'A', prfSalt: 'AAAA' }, credentials)

    expect(outcome).toEqual({ ok: false, reason: 'cancelled' })
    expect(credentials.get).not.toHaveBeenCalled()
  })

  it('evaluates prf on an assertion when the authenticator does not at creation', async () => {
    const credentials = authenticator({ evalAtCreate: false })

    const made = await makeReplicaReadableOffline({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      label: 'Notes',
      fetch: daemonAnswering(),
      credentials,
    })

    expect(made).toEqual({ ok: true })
    expect(
      await unlockReplicaKey({ daemonBaseUrl: DAEMON, workspaceId: WORKSPACE, credentials }),
    ).toEqual({ ok: true, tier: 'offline' })
  })

  it('creates no passkey when the daemon cannot hand over the key', async () => {
    const credentials = authenticator()

    const made = await makeReplicaReadableOffline({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      label: 'Notes',
      fetch: unreachable,
      credentials,
    })

    // The key must be held to be wrapped; a passkey minted first would be
    // one the person has to find and delete for nothing.
    expect(made).toEqual({ ok: false, reason: 'unreachable' })
    expect(credentials.create).not.toHaveBeenCalled()
    expect(isReplicaReadableOffline(DAEMON, WORKSPACE)).toBe(false)
  })

  it('says a browser whose passkeys have no prf cannot do this, and keeps nothing', async () => {
    const made = await makeReplicaReadableOffline({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      label: 'Notes',
      fetch: daemonAnswering(),
      credentials: authenticator({ prf: false }),
    })

    expect(made).toEqual({ ok: false, reason: 'unsupported' })
    expect(loadOfflinePasskey(DAEMON, WORKSPACE)).toBeNull()
    expect(loadWrappedKey(DAEMON, WORKSPACE)).toBeNull()
  })

  it('says a browser without WebAuthn cannot do this, without asking the daemon', async () => {
    const fetch = daemonAnswering()

    const made = await makeReplicaReadableOffline({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      label: 'Notes',
      fetch,
      credentials: undefined,
    })

    expect(made).toEqual({ ok: false, reason: 'unsupported' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports a dismissed prompt as cancelled and keeps nothing', async () => {
    const credentials = authenticator()
    vi.mocked(credentials.create).mockRejectedValueOnce(
      Object.assign(new Error('dismissed'), { name: 'NotAllowedError' }),
    )

    const made = await makeReplicaReadableOffline({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      label: 'Notes',
      fetch: daemonAnswering(),
      credentials,
    })

    expect(made).toEqual({ ok: false, reason: 'cancelled' })
    expect(isReplicaReadableOffline(DAEMON, WORKSPACE)).toBe(false)
  })

  it('refuses a workspace whose keeper keeps no copy offline', async () => {
    const credentials = authenticator()

    const made = await makeReplicaReadableOffline({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      label: 'Notes',
      fetch: daemonAnswering({ ...RESPONSE, tier: 'no-offline' }),
      credentials,
    })

    expect(made).toEqual({ ok: false, reason: 'no-offline' })
    expect(credentials.create).not.toHaveBeenCalled()
  })
})

describe('stopReplicaReadableOffline', () => {
  it('drops the wrapped key and the local passkey record, so nothing offers an unlock', async () => {
    await makeReplicaReadableOffline({
      daemonBaseUrl: DAEMON,
      workspaceId: WORKSPACE,
      label: 'Notes',
      fetch: daemonAnswering(),
      credentials: authenticator(),
    })

    stopReplicaReadableOffline(DAEMON, WORKSPACE)

    expect(isReplicaReadableOffline(DAEMON, WORKSPACE)).toBe(false)
    expect(loadWrappedKey(DAEMON, WORKSPACE)).toBeNull()
    expect(loadOfflinePasskey(DAEMON, WORKSPACE)).toBeNull()
  })
})
