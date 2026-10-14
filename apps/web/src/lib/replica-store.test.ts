/**
 * Which stored keys `openDocumentStore` seals, over fake IndexedDB: only the
 * workspace record of a workspace marked as a daemon replica. The Chromium
 * file beside it owns the rest of the factory (withholding, rotation, the
 * store-dump guard); this one pins the routing decision at the node layer.
 */
import 'fake-indexeddb/auto'
import { replicaKeyApiUrl } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { forgetAllForTests } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import type { DocRef } from '@kamiazya/whiteboard-ports'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearNamedDb } from '../test-utils/browser-document.js'
import { jsonResponse } from '../test-utils/json-response.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { replicaKeyFetch } from '../test-utils/replica-key-fetch.js'
import { connectReplicaKeeper, markReplica, openDocumentStore } from './replica-store.js'

const DB_NAME = 'whiteboard-replica-store-routing-test'
const DAEMON = 'http://127.0.0.1:3098'
const MARKER = 'a-plaintext-marker-nobody-should-see-sealed'

let counter = 0
// `markReplica`'s mark is module state with no reset, so each test mints its own id.
function freshWorkspaceId(): string {
  counter += 1
  return `routingtest${counter}`
}

/** Every string and byte run held by any object store, decoded as text. */
async function storedText(): Promise<string> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const parts: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') parts.push(value)
    else if (ArrayBuffer.isView(value)) parts.push(new TextDecoder().decode(value as Uint8Array))
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(visit)
  }
  for (const name of Array.from(db.objectStoreNames)) {
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const req = db.transaction([name], 'readonly').objectStore(name).getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    visit(records)
  }
  db.close()
  return parts.join('\n')
}

async function save(docRef: DocRef): Promise<void> {
  const { manifest, chunks } = chunkSnapshot(new TextEncoder().encode(MARKER), 200)
  await openDocumentStore(DB_NAME).saveSnapshot({
    docRef,
    manifest,
    chunks,
    frontier: new Uint8Array(4),
  })
}

describe('openDocumentStore routing', () => {
  beforeEach(async () => {
    await clearNamedDb(DB_NAME)
    connectReplicaKeeper({ baseUrl: DAEMON, fetch: replicaKeyFetch() })
  })

  afterEach(async () => {
    connectReplicaKeeper(null)
    forgetAllForTests()
    await clearNamedDb(DB_NAME)
  })

  it('seals the workspace record of a workspace marked as a daemon replica', async () => {
    const workspaceId = freshWorkspaceId()
    markReplica(workspaceId, DAEMON)
    await save({ kind: 'workspace-tree', workspaceId })
    expect(await storedText()).not.toContain(MARKER)
  })

  it('leaves the workspace record of an unmarked workspace as the bare bytes', async () => {
    await save({ kind: 'workspace-tree', workspaceId: freshWorkspaceId() })
    expect(await storedText()).toContain(MARKER)
  })

  it('never seals a document ref, even in a workspace marked as a daemon replica', async () => {
    const workspaceId = freshWorkspaceId()
    markReplica(workspaceId, DAEMON)
    await save({ kind: 'document', workspaceId, documentId: '01JD0ROUTINGTEST00000000001' })
    expect(await storedText()).toContain(MARKER)
  })

  // The holder maps drift to a withheld key of its own and never throws it, so
  // the composition root's report is the one place the route and the field
  // that disagreed are recorded.
  it('reports a drifted key answer to the app logger, and seals nothing under it', async () => {
    connectReplicaKeeper({
      baseUrl: DAEMON,
      fetch: (async () => jsonResponse({ workspaceKey: 7, tier: 'offline' })) as typeof fetch,
    })
    const workspaceId = freshWorkspaceId()
    markReplica(workspaceId, DAEMON)

    await expect(save({ kind: 'workspace-tree', workspaceId })).rejects.toThrow()

    await expectLoggedFailure(`${replicaKeyApiUrl(workspaceId)} failed its contract`)
    expect(await storedText()).not.toContain(MARKER)
  })
})
