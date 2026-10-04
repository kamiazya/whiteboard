/**
 * Which stored keys `openDocumentStore` seals, over fake IndexedDB: only the
 * workspace record of a workspace marked as a daemon replica. The Chromium
 * file beside it owns the rest of the factory (withholding, rotation, the
 * store-dump guard); this one pins the routing decision at the node layer.
 */
import 'fake-indexeddb/auto'
import { forgetAllForTests } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import { bytesToBase64Url } from '@kamiazya/whiteboard-model'
import type { DocRef } from '@kamiazya/whiteboard-ports'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearNamedDb } from '../test-utils/browser-document.js'
import { jsonResponse } from '../test-utils/json-response.js'
import { connectReplicaKeeper, markReplica, openDocumentStore } from './replica-store.js'

const DB_NAME = 'whiteboard-replica-store-routing-test'
const DAEMON = 'http://127.0.0.1:3098'
const MARKER = 'a-plaintext-marker-nobody-should-see-sealed'
const WORKSPACE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const WORKSPACE_SALT = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i)

const offlineKeyFetch = (async (input: Request | string | URL) => {
  const url = input instanceof Request ? input.url : String(input)
  if (!url.endsWith('/replica-key')) throw new Error(`unexpected fetch ${url}`)
  return jsonResponse({
    workspaceKey: bytesToBase64Url(WORKSPACE_KEY),
    workspaceKeySalt: bytesToBase64Url(WORKSPACE_SALT),
    tier: 'offline',
  })
}) as typeof fetch

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
    connectReplicaKeeper({ baseUrl: DAEMON, fetch: offlineKeyFetch })
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
})
