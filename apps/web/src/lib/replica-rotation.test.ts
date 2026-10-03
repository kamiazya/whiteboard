/**
 * What a rotated workspace key does to a cached replica, from the browser's
 * side (ADR-0042 decision 1, key rotation): the stored copy is sealed under a
 * key the daemon no longer hands out, and the pull that should replace it
 * must neither fail for good nor call the copy damaged.
 *
 * jsdom + fake-indexeddb with the real sealing stack: the claim being pinned
 * is about which bytes a pull overwrites, so nothing between the daemon double
 * and the IndexedDB records is replaced.
 */
import 'fake-indexeddb/auto'
import { forgetAllForTests } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import {
  createWorkspaceDocumentAtPath,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import { bytesToBase64Url } from '@kamiazya/whiteboard-model'
import { StoredDocumentUnreadableError } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { fc, withDefaults } from '../test-utils/fast-check.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { jsonResponse } from '../test-utils/json-response.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { cacheDaemonWorkspace } from './replica-cache.js'
import { connectReplicaKeeper } from './replica-store.js'
import { loadWrappedKey, saveWrappedKey } from './replica-wrapped-key-store.js'
import { findReplicaForHandle, withReplicaEntry } from './replicas.js'
import { ReplicaKeyRotatedError } from './sealed-document-store.js'
import { createUserSettingsStore, STORAGE_KEY } from './user-settings-store.js'

claimIsolatedWhiteboardDb('replica-rotation')

const BASE = 'http://127.0.0.1:3099'
const WORKSPACE = '01ARZ3NDEKTSV4RRFFQ69G5FR0'
const DOC = '01ARZ3NDEKTSV4RRFFQ69G5FR1'

interface Generation {
  key: Uint8Array
  salt: Uint8Array
  keyId: string
}

/** A distinct key generation per `seed`; `keyId` is any 16-byte base64url value. */
function generation(seed: number): Generation {
  return {
    key: Uint8Array.from({ length: 32 }, (_, i) => (seed * 37 + i) % 256),
    salt: Uint8Array.from({ length: 16 }, (_, i) => (seed * 11 + i) % 256),
    keyId: bytesToBase64Url(Uint8Array.from({ length: 16 }, (_, i) => (seed * 7 + i) % 256)),
  }
}

function daemonRecord(): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'notes/plan', documentId: DOC, kind: 'markdown' })
  doc.commit()
  return doc
}

/** The daemon's key route and snapshot route, answering for whichever generation is current when asked. */
function daemonAt(
  current: () => Generation,
  record: LoroDoc,
  workspaceId: string,
  { namesKey = true }: { namesKey?: boolean } = {},
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/replica-key')) {
      return jsonResponse({
        workspaceKey: bytesToBase64Url(current().key),
        workspaceKeySalt: bytesToBase64Url(current().salt),
        tier: 'offline',
        ...(namesKey ? { keyId: current().keyId } : {}),
      })
    }
    if (url.endsWith(`/api/w/${workspaceId}/workspace-document/snapshot`)) {
      return new Response(record.export({ mode: 'snapshot' }) as BodyInit, { status: 200 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof globalThis.fetch
}

/** A tab opened while the daemon is at `current`: it holds no key until it asks. */
function openTab(
  current: () => Generation,
  record: LoroDoc,
  workspaceId = WORKSPACE,
  options?: { namesKey?: boolean },
): typeof globalThis.fetch {
  forgetAllForTests()
  const fetch = daemonAt(current, record, workspaceId, options)
  connectReplicaKeeper({ baseUrl: BASE, token: 'tok', fetch })
  return fetch
}

/** One pull, registered the way the background refresh registers it. */
async function pull(fetch: typeof globalThis.fetch, workspaceId = WORKSPACE) {
  const result = await cacheDaemonWorkspace({
    fetch,
    daemonBaseUrl: BASE,
    workspaceId,
    workspaceDocs: new BrowserWorkspaceDocs(),
  })
  if (result.kind === 'ok') {
    createUserSettingsStore().update((s) =>
      withReplicaEntry(s, workspaceId, {
        daemonBaseUrl: BASE,
        syncedAt: result.syncedAt,
        syncedFrontier: result.syncedFrontier,
        ...(result.keyId === undefined ? {} : { keyId: result.keyId }),
      }),
    )
  }
  return result
}

const WRAPPED = { v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA' } as const

describe('a replica across a workspace key rotation', () => {
  beforeEach(async () => {
    localStorage.removeItem(STORAGE_KEY)
    await clearWhiteboardDb()
  })
  afterEach(() => {
    connectReplicaKeeper(null)
    forgetAllForTests()
  })

  it('the next pull replaces a copy sealed under the superseded key', async () => {
    const record = daemonRecord()
    const first = await pull(openTab(() => generation(1), record))
    expect(first.kind).toBe('ok')

    const second = await pull(openTab(() => generation(2), record))

    expect(second.kind).toBe('ok')
    await expectLoggedFailure('replaced key')
    const stored = await new BrowserWorkspaceDocs().open(WORKSPACE)
    expect(readWorkspaceDocuments(stored as LoroDoc).map((e) => e.path)).toEqual(['notes/plan'])
  })

  it('records the key id the copy is now sealed under', async () => {
    const record = daemonRecord()
    await pull(openTab(() => generation(1), record))
    await pull(openTab(() => generation(2), record))
    await expectLoggedFailure('replaced key')

    const entry = findReplicaForHandle(createUserSettingsStore().load(), WORKSPACE)
    expect(entry?.keyId).toBe(generation(2).keyId)
  })

  it('reads a copy sealed under a superseded key as rotated, never as damaged', async () => {
    const record = daemonRecord()
    await pull(openTab(() => generation(1), record))

    openTab(() => generation(2), record)

    await expect(new BrowserWorkspaceDocs().open(WORKSPACE)).rejects.toBeInstanceOf(
      ReplicaKeyRotatedError,
    )
  })

  it('still reads a copy when the daemon has not rotated', async () => {
    const record = daemonRecord()
    await pull(openTab(() => generation(1), record))

    openTab(() => generation(1), record)

    const stored = await new BrowserWorkspaceDocs().open(WORKSPACE)
    expect(readWorkspaceDocuments(stored as LoroDoc)).toHaveLength(1)
  })

  it('cannot tell a rotation from a daemon that names no key, and reads as before', async () => {
    // A daemon that predates rotation has no rotation to report, so reading a
    // copy the old way is right; refusing it would call a readable copy stale.
    const record = daemonRecord()
    await pull(openTab(() => generation(1), record))

    openTab(() => generation(1), record, WORKSPACE, { namesKey: false })

    const stored = await new BrowserWorkspaceDocs().open(WORKSPACE)
    expect(readWorkspaceDocuments(stored as LoroDoc)).toHaveLength(1)
  })

  it('drops the wrapped key of the copy it replaces, since it opens the superseded generation', async () => {
    const record = daemonRecord()
    await pull(openTab(() => generation(1), record))
    saveWrappedKey(BASE, WORKSPACE, WRAPPED)

    await pull(openTab(() => generation(2), record))
    await expectLoggedFailure('replaced key')

    expect(loadWrappedKey(BASE, WORKSPACE)).toBeNull()
  })

  it('keeps the wrapped key when the pull replaced nothing', async () => {
    const record = daemonRecord()
    await pull(openTab(() => generation(1), record))
    saveWrappedKey(BASE, WORKSPACE, WRAPPED)

    await pull(openTab(() => generation(1), record))

    expect(loadWrappedKey(BASE, WORKSPACE)).toEqual(WRAPPED)
  })
})

type Op = 'rotate' | 'newTab' | 'refresh' | 'read'

describe('rotate, refresh and read in any order', () => {
  let counter = 0
  const freshWorkspaceId = () => {
    counter += 1
    return `01JD0ROTATION${String(counter).padStart(13, '0')}`
  }

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
  })
  afterEach(() => {
    connectReplicaKeeper(null)
    forgetAllForTests()
  })

  it('a read is never "damaged", and a pull always leaves the copy readable', async () => {
    // The model is three integers: the daemon's key generation, the one this
    // tab holds (null until it first asks) and the one the stored copy is
    // sealed under (null with no copy). It shares nothing with the code under
    // test, so a wrong key-id comparison cannot also bend the expectation.
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Op>('rotate', 'newTab', 'refresh', 'read'), {
          minLength: 1,
          maxLength: 8,
        }),
        async (ops) => {
          const workspaceId = freshWorkspaceId()
          const record = daemonRecord()
          let daemonGen = 1
          let held: number | null = null
          let copy: number | null = null
          let dropped = false
          const current = () => generation(daemonGen)
          const fetch = openTab(current, record, workspaceId)
          for (const op of ops) {
            if (op === 'rotate') daemonGen += 1
            if (op === 'newTab') {
              held = null
              openTab(current, record, workspaceId)
            }
            // Both a pull and a read of an existing copy ask the holder, which
            // asks the daemon once and keeps the answer for the life of the tab.
            if (op === 'refresh' || (op === 'read' && copy !== null)) held ??= daemonGen
            if (op === 'refresh') {
              const result = await pull(fetch, workspaceId)
              expect(result.kind).toBe('ok')
              dropped ||= copy !== null && copy !== held
              copy = held
            }
            if (op === 'read') {
              const outcome = await new BrowserWorkspaceDocs()
                .open(workspaceId)
                .then((doc) => (doc === null ? 'none' : 'ok'))
                .catch((error: unknown) => {
                  expect(error).not.toBeInstanceOf(StoredDocumentUnreadableError)
                  return error instanceof ReplicaKeyRotatedError ? 'rotated' : 'other'
                })
              expect(outcome).toBe(copy === null ? 'none' : copy === held ? 'ok' : 'rotated')
            }
          }
          if (dropped) await expectLoggedFailure('replaced key')
        },
      ),
      withDefaults({ numRuns: 12 }),
    )
  }, 120_000)
})
