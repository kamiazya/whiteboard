/**
 * A replica's images, over REAL IndexedDB: pulled with the record through the
 * daemon's file route, sealed under the record's key, dropped when the record
 * stops naming them or the copy is deleted — and never confused with the
 * images the browser keeps for its own workspaces, in either direction.
 */
import { forgetAllForTests } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readSpatialCanvas,
  reconcileSpatialCanvas,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { newImageRef } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { replicaKeyFetch } from '../test-utils/replica-key-fetch.js'
import { sweepUnreferencedFiles } from './browser-file-sweep.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { DocumentFileStore } from './document-file-store.js'
import { IdbBlobStore } from './idb-blob-store.js'
import { cacheDaemonWorkspace } from './replica-cache.js'
import { readReplicaImagePointer } from './replica-image-store.js'
import { cacheReplicaImages, loadReplicaImages } from './replica-images.js'
import { connectReplicaKeeper, markReplica, openDocumentStore } from './replica-store.js'
import { withReplicaEntry } from './replicas.js'
import { createUserSettingsStore, STORAGE_KEY } from './user-settings-store.js'

const DB_NAME = claimIsolatedWhiteboardDb('replica-images')

const BASE = 'http://127.0.0.1:3099'
const DAEMON_WS = '01ARZ3NDEKTSV4RRFFQ69G5FC0'
const BOARD = '01ARZ3NDEKTSV4RRFFQ69G5FC1'
const IMAGES_KEY = 'whiteboard:replica-images'

/** Distinct, readable bytes per image, so a plaintext copy anywhere is findable. */
function pictureOf(fileId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`picture-plaintext:${fileId}`)
}

function boardNaming(...fileIds: string[]): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'boards/photo', documentId: BOARD, kind: 'spatial' })
  writeSpatialCanvas(documentContainers(doc, BOARD), {
    nodes: fileIds.map((id, i) =>
      fileNode({ id: `n-${id}`, file: newImageRef(id), x: i * 120, y: 0, width: 100, height: 100 }),
    ),
    edges: [],
  })
  doc.commit()
  return doc
}

/** The daemon as its key, snapshot and file routes; `served` records each file read. */
function daemon(record: LoroDoc, served: string[] = []): typeof globalThis.fetch {
  return replicaKeyFetch({}, (url) => {
    if (url.endsWith(`/api/w/${DAEMON_WS}/workspace-document/snapshot`)) {
      return new Response(record.export({ mode: 'snapshot' }) as BodyInit, { status: 200 })
    }
    const file = /\/document\/boards\/photo\/file\/([\w-]+)$/.exec(url)
    if (file?.[1] !== undefined) {
      served.push(file[1])
      return new Response(pictureOf(file[1]) as BodyInit, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })
    }
    return new Response('not found', { status: 404 })
  })
}

async function pull(record: LoroDoc, served?: string[]): Promise<void> {
  const fetch = daemon(record, served)
  connectReplicaKeeper({ baseUrl: BASE, fetch })
  const result = await cacheDaemonWorkspace({
    fetch,
    daemonBaseUrl: BASE,
    workspaceId: DAEMON_WS,
    workspaceDocs: new BrowserWorkspaceDocs(),
  })
  if (result.kind !== 'ok') throw new Error(`pull failed: ${result.kind}`)
}

async function textOf(blob: Blob | undefined): Promise<string | undefined> {
  return blob === undefined ? undefined : new TextDecoder().decode(await blob.arrayBuffer())
}

/** Every string (and UTF-8-decoded byte array) held anywhere in the database. */
async function dumpRawStrings(): Promise<string[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const out: string[] = []
  const collect = (value: unknown): void => {
    if (typeof value === 'string') out.push(value)
    else if (ArrayBuffer.isView(value)) out.push(new TextDecoder().decode(value as Uint8Array))
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect)
  }
  for (const name of Array.from(db.objectStoreNames)) {
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const req = db.transaction([name], 'readonly').objectStore(name).getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    rows.forEach(collect)
  }
  db.close()
  return out
}

describe('replica images', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    markReplica(DAEMON_WS, BASE)
  })
  afterEach(() => {
    connectReplicaKeeper(null)
    forgetAllForTests()
    localStorage.removeItem(IMAGES_KEY)
    localStorage.removeItem(STORAGE_KEY)
  })

  it('a pull caches the pictures its record names, sealed at rest', async () => {
    const served: string[] = []
    await pull(boardNaming('img-cat'), served)

    expect(served).toEqual(['img-cat'])
    const loaded = (await loadReplicaImages(DAEMON_WS, ['img-cat'])).images
    expect(await textOf(loaded.get('img-cat'))).toBe('picture-plaintext:img-cat')
    expect(loaded.get('img-cat')?.type).toBe('image/png')

    const dump = await dumpRawStrings()
    expect(dump.some((text) => text.includes('picture-plaintext'))).toBe(false)
    expect(localStorage.getItem(IMAGES_KEY)).not.toContain('img-cat')
  })

  it('a re-pull keeps what it holds and drops a picture the record stopped naming', async () => {
    const record = boardNaming('img-cat', 'img-dog')
    await pull(record)
    const before = readReplicaImagePointer(DAEMON_WS)?.blobs ?? []
    expect(before).toHaveLength(2)

    const canvas = readSpatialCanvas(documentContainers(record, BOARD))
    reconcileSpatialCanvas(documentContainers(record, BOARD), canvas, {
      ...canvas,
      nodes: canvas.nodes.filter((node) => node.id !== 'n-img-dog'),
    })
    record.commit()
    const served: string[] = []
    await pull(record, served)

    expect(served).toEqual([])
    const loaded = (await loadReplicaImages(DAEMON_WS, ['img-cat', 'img-dog'])).images
    expect([...loaded.keys()]).toEqual(['img-cat'])
    const after = readReplicaImagePointer(DAEMON_WS)?.blobs ?? []
    const blobs = new IdbBlobStore()
    const held = await Promise.all(before.map(async (ref) => (await blobs.has({ ref })).exists))
    expect(held.filter(Boolean)).toHaveLength(1)
    expect(after).toHaveLength(1)
  })

  it('caches what fits the budget and leaves the rest uncached', async () => {
    const record = boardNaming('img-cat', 'img-dog')
    const fetch = daemon(record)
    connectReplicaKeeper({ baseUrl: BASE, fetch })
    await new BrowserWorkspaceDocs().save(DAEMON_WS, record)

    const budgetBytes = pictureOf('img-cat').byteLength
    const cached = await cacheReplicaImages({
      fetch,
      daemonBaseUrl: BASE,
      workspaceId: DAEMON_WS,
      record,
      budgetBytes,
    })

    expect(cached).toBe(1)
    const loaded = (await loadReplicaImages(DAEMON_WS, ['img-cat', 'img-dog'])).images
    expect([...loaded.keys()]).toEqual(['img-cat'])
  })

  it("deleting the copy takes its pictures, and leaves the browser's own copy of the same one", async () => {
    await new DocumentFileStore().put(newImageRef('img-cat'), {
      mimeType: 'image/png',
      blob: new Blob([pictureOf('img-cat')], { type: 'image/png' }),
      created: 0,
    })
    await pull(boardNaming('img-cat'))
    const refs = readReplicaImagePointer(DAEMON_WS)?.blobs ?? []
    expect(refs).toHaveLength(1)

    await openDocumentStore().deleteDoc({
      docRef: { kind: 'workspace-tree', workspaceId: DAEMON_WS },
    })

    expect(readReplicaImagePointer(DAEMON_WS)).toBeUndefined()
    const blobs = new IdbBlobStore()
    expect((await blobs.has({ ref: refs[0]! })).exists).toBe(false)
    const own = await new DocumentFileStore().read(newImageRef('img-cat'))
    expect(await textOf(own.kind === 'blob' ? own.blob : undefined)).toBe(
      'picture-plaintext:img-cat',
    )
  })

  it("the browser's file sweep leaves a replica's pictures alone", async () => {
    await pull(boardNaming('img-cat'))
    createUserSettingsStore().update((current) =>
      withReplicaEntry(current, DAEMON_WS, { daemonBaseUrl: BASE, syncedAt: '' }),
    )

    const swept = await sweepUnreferencedFiles({ graceMs: 0 })

    expect(swept.kind).toBe('swept')
    const loaded = (await loadReplicaImages(DAEMON_WS, ['img-cat'])).images
    expect(await textOf(loaded.get('img-cat'))).toBe('picture-plaintext:img-cat')
  })
})
