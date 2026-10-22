/**
 * A remembered copy never outranks a daemon decision (ADR-0042 decision 6).
 *
 * When the daemon REACHES this device and refuses the key because access was
 * withdrawn, the wrapped key on disk goes with it — otherwise a later cold
 * start with the daemon unreachable would offer the unlock again and open the
 * copy as it stood at removal. Silence (a rejected fetch, a 5xx naming no
 * refusal) and a refusal that reconnecting fixes are not decisions, and must
 * leave the remembered copy openable.
 */

import { forgetAllForTests } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import { replicaKeyBody, replicaKeyRefusalFetch } from '../test-utils/replica-key-fetch.js'
import { saveOfflinePasskey } from './replica-offline-passkey.js'
import { connectReplicaKeeper, markReplica, replicaRecordKey } from './replica-store.js'
import { isReplicaReadableOffline, rememberReplicaKey, unlockReplicaKey } from './replica-unlock.js'

const DAEMON = 'http://127.0.0.1:3097'
const PRF = new Uint8Array(32).fill(7)

let counter = 0
// `markReplica`'s mark is module state with no reset, so each test mints its own id.
function freshWorkspaceId(): string {
  counter += 1
  return `withdrawntest${counter}`
}

/** A copy made readable offline, as Settings' opt-in leaves it. */
async function rememberCopy(workspaceId: string): Promise<void> {
  await rememberReplicaKey({
    daemonBaseUrl: DAEMON,
    workspaceId,
    response: replicaKeyBody(),
    prfOutput: PRF,
  })
  saveOfflinePasskey(DAEMON, workspaceId, { credentialId: 'AQIDBA', prfSalt: 'BQYHCA' })
}

/** Asks the daemon for the key through the one routing seam, answering `fetch`. */
async function askKey(workspaceId: string, fetch: typeof globalThis.fetch): Promise<void> {
  connectReplicaKeeper({ baseUrl: DAEMON, fetch })
  markReplica(workspaceId, DAEMON)
  expect(await replicaRecordKey(workspaceId)).toBeNull()
}

/** The cold start that follows: a fresh tab, nothing held, the daemon out of reach. */
function coldStartOffline(): void {
  connectReplicaKeeper(null)
  forgetAllForTests()
}

beforeEach(() => {
  localStorage.clear()
  forgetAllForTests()
})

afterEach(() => {
  connectReplicaKeeper(null)
  forgetAllForTests()
  localStorage.clear()
})

describe('a key refusal that withdraws access', () => {
  it.each([
    'not_a_member',
    'replica_not_allowed',
    'workspace_not_found',
  ])('drops the remembered key on %s', async (code) => {
    const workspaceId = freshWorkspaceId()
    await rememberCopy(workspaceId)

    await askKey(workspaceId, replicaKeyRefusalFetch(code))
    coldStartOffline()

    expect(isReplicaReadableOffline(DAEMON, workspaceId)).toBe(false)
    expect(await unlockReplicaKey({ daemonBaseUrl: DAEMON, workspaceId })).toEqual({
      ok: false,
      reason: 'no-blob',
    })
  })
})

describe('a key ask that decided nothing', () => {
  const silent: Record<string, typeof globalThis.fetch> = {
    'a rejected fetch': (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch,
    'a 5xx naming no refusal': (async () =>
      jsonResponse({ error: 'internal', message: 'boom' }, 503)) as typeof fetch,
    'a refusal reconnecting fixes': replicaKeyRefusalFetch('requires_person_session'),
  }

  it.each(Object.keys(silent))('keeps the remembered key after %s', async (name) => {
    const workspaceId = freshWorkspaceId()
    await rememberCopy(workspaceId)

    await askKey(workspaceId, silent[name] as typeof fetch)
    coldStartOffline()

    expect(isReplicaReadableOffline(DAEMON, workspaceId)).toBe(true)
  })
})
