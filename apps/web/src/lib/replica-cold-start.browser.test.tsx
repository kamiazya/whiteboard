/**
 * A cold start, end to end, in a real browser (ADR-0042 decision 6).
 *
 * The two halves are only worth anything together, and each is written
 * against a double on its own: this drives the real factory over real
 * IndexedDB and real WebCrypto, so what is asserted is that a replica sealed
 * by one session is READ by a later one with no daemon in reach.
 */
import { forgetAll } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import type { DocRef } from '@kamiazya/whiteboard-ports'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearNamedDb } from '../test-utils/browser-document.js'
import type { PasskeyCredentials } from './passkey-attestation.js'
import { connectReplicaKeeper, markReplica, openDocumentStore } from './replica-store.js'
import { unlockReplicaKey } from './replica-unlock.js'

const DB_NAME = 'whiteboard-replica-cold-start'
const DAEMON = 'http://127.0.0.1:3099'
const SEALED_KEYS = 'whiteboard:replica-sealed-keys'
const PASSKEYS = 'whiteboard:daemon-passkeys'

const RAW_ID = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])
const PRF = new Uint8Array(32).fill(11)
const WORKSPACE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const WORKSPACE_SALT = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i)

let workspaceCounter = 0
function freshWorkspaceId(): string {
  workspaceCounter += 1
  return `01JD0COLDSTART00${String(workspaceCounter).padStart(8, '0')}`
}

function b64u(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

/**
 * The real sequence: the first key request is refused for want of a person,
 * the bind follows, and the retry is answered. That refusal is what makes
 * the gesture happen, which is what produces the wrapping material.
 */
function bindThenKeyFetch(): { fetch: typeof fetch; calls: () => string[] } {
  const urls: string[] = []
  let bound = false
  const impl = (async (input: Request | string | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    urls.push(url)
    if (url.endsWith('/session-assert/challenge')) {
      return jsonResponse({
        challenge: b64u(new Uint8Array(32).fill(3)),
        expiresAt: '2030-01-01T00:00:00.000Z',
      })
    }
    if (url.endsWith('/session-assert')) {
      bound = true
      return jsonResponse({
        credentialId: b64u(RAW_ID),
        profileId: null,
        boundUntil: '2030-01-01T01:00:00.000Z',
      })
    }
    if (url.endsWith('/replica-key')) {
      return bound
        ? jsonResponse({
            workspaceKey: b64u(WORKSPACE_KEY),
            workspaceKeySalt: b64u(WORKSPACE_SALT),
            tier: 'offline',
          })
        : jsonResponse({ error: 'requires_person_session', message: 'bind first' }, 403)
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
  return { fetch: impl, calls: () => urls }
}

function credentialsYieldingPrf(): { credentials: PasskeyCredentials; prompts: () => number } {
  let prompts = 0
  return {
    credentials: {
      create: async () => null,
      get: async () => {
        prompts += 1
        return {
          rawId: RAW_ID.buffer,
          response: {
            authenticatorData: new Uint8Array(37).fill(1).buffer,
            clientDataJSON: new TextEncoder().encode('{"type":"webauthn.get"}').buffer,
            signature: new Uint8Array([7, 7, 7]).buffer,
          },
          getClientExtensionResults: () => ({ prf: { results: { first: PRF.buffer } } }),
        } as unknown as PublicKeyCredential
      },
    },
    prompts: () => prompts,
  }
}

const marker = 'cold-start-marker-nobody-should-see-plaintext'

beforeEach(async () => {
  localStorage.removeItem(SEALED_KEYS)
  localStorage.setItem(
    PASSKEYS,
    JSON.stringify({
      [DAEMON]: { credentialId: b64u(RAW_ID), registeredAt: '2026-09-21T00:00:00.000Z' },
    }),
  )
  await clearNamedDb(DB_NAME)
})

afterEach(async () => {
  connectReplicaKeeper(null)
  forgetAll()
  localStorage.removeItem(SEALED_KEYS)
  localStorage.removeItem(PASSKEYS)
  await clearNamedDb(DB_NAME)
})

describe('a replica sealed by one session is read by a later one', () => {
  it('remembers the key on the bind gesture, then opens the replica offline on one more', async () => {
    const workspaceId = freshWorkspaceId()
    const docRef: DocRef = { kind: 'workspace-tree', workspaceId }
    const daemon = bindThenKeyFetch()
    const { credentials, prompts } = credentialsYieldingPrf()

    connectReplicaKeeper({ baseUrl: DAEMON, token: 'tok', fetch: daemon.fetch, credentials })
    markReplica(workspaceId, DAEMON)

    const store = openDocumentStore(DB_NAME)
    const { manifest, chunks } = chunkSnapshot(new TextEncoder().encode(marker), 200)
    await store.saveSnapshot({ docRef, manifest, chunks, frontier: new Uint8Array(4) })

    // One gesture bound the session AND paid for the cold start.
    expect(prompts()).toBe(1)
    await expect
      .poll(() => localStorage.getItem(SEALED_KEYS))
      .toEqual(expect.stringContaining(workspaceId))
    // Ciphertext: the key's own text is not what was written.
    expect(localStorage.getItem(SEALED_KEYS)).not.toContain(b64u(WORKSPACE_KEY))

    // The tab closes: every key this session held is gone, and so is the
    // daemon. Only what IndexedDB and localStorage kept survives.
    forgetAll()
    connectReplicaKeeper(null)

    const outcome = await unlockReplicaKey({ daemonBaseUrl: DAEMON, workspaceId, credentials })
    expect(outcome).toEqual({ ok: true, tier: 'offline' })
    expect(prompts()).toBe(2)

    // The whole point: the sealed snapshot reads back with nothing to ask.
    const loaded = await openDocumentStore(DB_NAME).loadSnapshot({ docRef })
    expect(loaded?.chunks.map((c) => new TextDecoder().decode(c.bytes))).toEqual([marker])
  })
})
