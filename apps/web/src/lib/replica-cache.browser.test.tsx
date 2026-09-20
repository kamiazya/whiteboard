/**
 * The demote half of ADR-0023's decision 2, over REAL IndexedDB: a daemon
 * workspace's whole record pulled through the snapshot route and stored in
 * this browser's own planes as a replica — readable, overwritten by sync,
 * never authoritative. The daemon side of the GET is the existing
 * workspace-document/snapshot route; what this file pins is the browser
 * half — the pulled bytes landing in the store, and a re-pull merging
 * rather than forking.
 */
import { forgetAll } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import {
  createWorkspaceDocumentAtPath,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc, VersionVector } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { cacheDaemonWorkspace } from './replica-cache.js'
import { connectReplicaKeeper, markReplica, openDocumentStore } from './replica-store.js'
import { withReplicaEntry } from './replicas.js'
import { createUserSettingsStore, STORAGE_KEY } from './user-settings-store.js'

const DB_NAME = claimIsolatedWhiteboardDb('replica-cache')

const BASE = 'http://127.0.0.1:3099'
const DAEMON_WS = '01ARZ3NDEKTSV4RRFFQ69G5FA0'
const DOC_A = '01ARZ3NDEKTSV4RRFFQ69G5FA1'
const DOC_B = '01ARZ3NDEKTSV4RRFFQ69G5FA2'

const WORKSPACE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const WORKSPACE_SALT = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i)

function b64u(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * The daemon standing in as its snapshot route AND its `/replica-key`
 * route — production runs `cacheDaemonWorkspace` only once a keeper is
 * connected, so a pull's own store writes are always sealed, and this
 * double has to answer both requests the same way production's daemon does.
 */
function snapshotStub(record: LoroDoc, status = 200): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/replica-key')) {
      return new Response(
        JSON.stringify({
          workspaceKey: b64u(WORKSPACE_KEY),
          workspaceKeySalt: b64u(WORKSPACE_SALT),
          tier: 'offline',
        }),
        { status: 200 },
      )
    }
    if (url.endsWith(`/api/w/${DAEMON_WS}/workspace-document/snapshot`)) {
      if (status !== 200) return new Response('nope', { status })
      return new Response(record.export({ mode: 'snapshot' }) as BodyInit, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof globalThis.fetch
}

/** Every string (and UTF-8-decoded byte array) held anywhere in `dbName`'s object stores. */
async function dumpRawStrings(dbName: string): Promise<string[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const out: string[] = []
  function collect(value: unknown): void {
    if (typeof value === 'string') out.push(value)
    else if (ArrayBuffer.isView(value)) out.push(new TextDecoder().decode(value as Uint8Array))
    else if (Array.isArray(value)) for (const item of value) collect(item)
    else if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) collect(item)
    }
  }
  for (const storeName of Array.from(db.objectStoreNames)) {
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const req = db.transaction([storeName], 'readonly').objectStore(storeName).getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    for (const record of records) collect(record)
  }
  db.close()
  return out
}

function daemonRecord(...paths: Array<{ path: string; documentId: string }>): LoroDoc {
  const doc = new LoroDoc()
  for (const entry of paths) {
    createWorkspaceDocumentAtPath(doc, { ...entry, kind: 'markdown' })
  }
  doc.commit()
  return doc
}

describe('cacheDaemonWorkspace', () => {
  beforeEach(clearWhiteboardDb)
  afterEach(() => {
    connectReplicaKeeper(null)
    forgetAll()
  })

  it("reports the DAEMON's own frontier, not the merged local one, and keeps local edits", async () => {
    // The pull merges daemon bytes into a replica that may carry offline
    // edits. `syncedFrontier` claims what the DAEMON is known to hold — so
    // it must come from the pulled bytes alone. Deriving it from the merged
    // record would mark local edits as already-sent, and the push would
    // silently skip them forever.
    const record = daemonRecord({ path: 'notes/plan', documentId: DOC_A })
    connectReplicaKeeper({ baseUrl: BASE, token: 'tok', fetch: snapshotStub(record) })
    // The offline edit is seeded as if an earlier pull had already sealed
    // this replica — the same state `cacheDaemonWorkspace`'s own mark
    // leaves a workspace in once it has been pulled once.
    markReplica(DAEMON_WS, BASE)
    const docs = new BrowserWorkspaceDocs()
    const local = new LoroDoc()
    createWorkspaceDocumentAtPath(local, {
      path: 'offline/note',
      documentId: DOC_B,
      kind: 'markdown',
    })
    local.commit()
    await docs.save(DAEMON_WS, local)

    const result = await cacheDaemonWorkspace({
      fetch: snapshotStub(record),
      daemonBaseUrl: BASE,
      workspaceId: DAEMON_WS,
      workspaceDocs: docs,
    })
    if (result.kind !== 'ok') throw new Error(`pull failed: ${result.reason}`)

    // The local edit survived the merge...
    const merged = await docs.open(DAEMON_WS)
    expect(
      readWorkspaceDocuments(merged!)
        .map((e) => e.documentId)
        .sort(),
    ).toEqual([DOC_A, DOC_B].sort())
    // ...and the reported frontier covers the daemon's ops but NOT the
    // local edit: an update exported from it still carries something.
    const synced = VersionVector.decode(
      Uint8Array.from(atob(result.syncedFrontier), (c) => c.charCodeAt(0)),
    )
    const pending = merged!.export({ mode: 'update', from: synced })
    const probe = new LoroDoc()
    probe.import(record.export({ mode: 'snapshot' }))
    probe.import(pending)
    expect(
      readWorkspaceDocuments(probe)
        .map((e) => e.documentId)
        .sort(),
    ).toEqual([DOC_A, DOC_B].sort())
  })

  it('stores the pulled daemon record in the browser planes as a replica', async () => {
    const record = daemonRecord({ path: 'notes/plan', documentId: DOC_A })
    connectReplicaKeeper({ baseUrl: BASE, token: 'tok', fetch: snapshotStub(record) })
    const result = await cacheDaemonWorkspace({
      fetch: snapshotStub(record),
      daemonBaseUrl: BASE,
      workspaceId: DAEMON_WS,
      workspaceDocs: new BrowserWorkspaceDocs(),
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.documentCount).toBe(1)

    const replica = await new BrowserWorkspaceDocs().open(DAEMON_WS)
    expect(replica).not.toBeNull()
    expect(readWorkspaceDocuments(replica!).map((entry) => entry.path)).toEqual(['notes/plan'])
  })

  it('a re-pull merges into the stored replica instead of forking it', async () => {
    const record = daemonRecord({ path: 'notes/plan', documentId: DOC_A })
    connectReplicaKeeper({ baseUrl: BASE, token: 'tok', fetch: snapshotStub(record) })
    const docs = new BrowserWorkspaceDocs()
    await cacheDaemonWorkspace({
      fetch: snapshotStub(record),
      daemonBaseUrl: BASE,
      workspaceId: DAEMON_WS,
      workspaceDocs: docs,
    })
    // The daemon moved on: a second document exists by the next pull.
    createWorkspaceDocumentAtPath(record, {
      path: 'notes/next',
      documentId: DOC_B,
      kind: 'markdown',
    })
    record.commit()
    const second = await cacheDaemonWorkspace({
      fetch: snapshotStub(record),
      daemonBaseUrl: BASE,
      workspaceId: DAEMON_WS,
      workspaceDocs: docs,
    })
    expect(second.kind).toBe('ok')

    const replica = await new BrowserWorkspaceDocs().open(DAEMON_WS)
    expect(
      readWorkspaceDocuments(replica!)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(['notes/next', 'notes/plan'])
  })

  it('a refused pull fails structurally and writes nothing', async () => {
    const fetch = snapshotStub(daemonRecord({ path: 'notes/plan', documentId: DOC_A }), 404)
    connectReplicaKeeper({ baseUrl: BASE, token: 'tok', fetch })
    const result = await cacheDaemonWorkspace({
      fetch,
      daemonBaseUrl: BASE,
      workspaceId: DAEMON_WS,
      workspaceDocs: new BrowserWorkspaceDocs(),
    })
    expect(result.kind).toBe('failed')
    expect(await new BrowserWorkspaceDocs().open(DAEMON_WS)).toBeNull()
  })

  it('a thrown fetch fails structurally, never a rejected promise', async () => {
    const result = await cacheDaemonWorkspace({
      fetch: (async () => {
        throw new TypeError('network down')
      }) as typeof globalThis.fetch,
      daemonBaseUrl: BASE,
      workspaceId: DAEMON_WS,
      workspaceDocs: new BrowserWorkspaceDocs(),
    })
    expect(result.kind).toBe('failed')
    expect(await new BrowserWorkspaceDocs().open(DAEMON_WS)).toBeNull()
  })

  it('a first pull with no registry entry lands sealed and reads back once registered', async () => {
    localStorage.removeItem(STORAGE_KEY)
    const record = daemonRecord({ path: 'notes/first-pull-marker', documentId: DOC_A })
    connectReplicaKeeper({ baseUrl: BASE, token: 'tok', fetch: snapshotStub(record) })
    // The exact state both real callers (Settings' move, the background
    // refresh) are in mid-pull: no `storage.replicas` entry yet.
    const settings = createUserSettingsStore()
    expect(settings.load().storage.replicas?.[DAEMON_WS]).toBeUndefined()

    const result = await cacheDaemonWorkspace({
      fetch: snapshotStub(record),
      daemonBaseUrl: BASE,
      workspaceId: DAEMON_WS,
      workspaceDocs: new BrowserWorkspaceDocs(),
    })
    expect(result.kind).toBe('ok')

    const dump = await dumpRawStrings(DB_NAME)
    expect(dump.some((s) => s.includes('first-pull-marker'))).toBe(false)

    // Now the registry entry lands, as both real callers do once the pull returns.
    settings.update((current) =>
      withReplicaEntry(current, DAEMON_WS, {
        daemonBaseUrl: BASE,
        syncedAt: result.kind === 'ok' ? result.syncedAt : '',
      }),
    )
    const replica = await openDocumentStore().loadSnapshot({
      docRef: { kind: 'workspace-tree', workspaceId: DAEMON_WS },
    })
    expect(replica).not.toBeNull()
    localStorage.removeItem(STORAGE_KEY)
  })
})
