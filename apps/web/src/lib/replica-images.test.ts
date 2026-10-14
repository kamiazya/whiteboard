/**
 * A replica's images over fake-indexeddb, with the real sealing stack: what a
 * pull files, what it keeps, drops and refuses, and what a reader can open.
 * The real-browser counterpart (`replica-images.browser.test.tsx`) pins the
 * same flow against real IndexedDB and the browser's own file sweep; this
 * file adds the degraded paths a browser cannot be made to produce on cue —
 * a refused pointer write, a blob store that fails, an index that will not
 * open.
 */
import 'fake-indexeddb/auto'
import { forgetAllForTests } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readSpatialCanvas,
  reconcileSpatialCanvas,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { bytesToBase64Url, newImageRef } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import type { BlobRef, BlobStore } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { jsonResponse } from '../test-utils/json-response.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { IdbBlobStore } from './idb-blob-store.js'
import { cacheDaemonWorkspace } from './replica-cache.js'
import { replicaClipboardImages } from './replica-clipboard-images.js'
import {
  deleteReplicaImageBlobs,
  dropReplicaImages,
  readReplicaImagePointer,
  withReplicaImagesLock,
  writeReplicaImagePointer,
} from './replica-image-store.js'
import {
  cacheReplicaImages,
  loadReplicaImages,
  loadReplicaImagesRetrying,
} from './replica-images.js'
import { connectReplicaKeeper, markReplica } from './replica-store.js'

claimIsolatedWhiteboardDb('replica-images-jsdom')

const BASE = 'http://127.0.0.1:3099'
const DAEMON_WS = '01ARZ3NDEKTSV4RRFFQ69G5FD0'
const BOARD = '01ARZ3NDEKTSV4RRFFQ69G5FD1'
const IMAGES_KEY = 'whiteboard:replica-images'

const WORKSPACE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const WORKSPACE_SALT = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i)

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

interface DaemonOptions {
  served?: string[]
  /** File ids the daemon answers 404 for. */
  missing?: readonly string[]
  /** File ids whose read fails at the network. */
  unreachable?: readonly string[]
  /** File ids served padded to this many bytes, past their readable prefix. */
  paddedTo?: Readonly<Record<string, number>>
}

/** The daemon as its key, snapshot and file routes; `served` records each file read. */
function daemon(record: LoroDoc, options: DaemonOptions = {}): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/replica-key')) {
      return jsonResponse({
        workspaceKey: bytesToBase64Url(WORKSPACE_KEY),
        workspaceKeySalt: bytesToBase64Url(WORKSPACE_SALT),
        tier: 'offline',
      })
    }
    if (url.endsWith(`/api/w/${DAEMON_WS}/workspace-document/snapshot`)) {
      return new Response(record.export({ mode: 'snapshot' }) as BodyInit, { status: 200 })
    }
    const file = /\/document\/boards\/photo\/file\/([\w-]+)$/.exec(url)
    if (file?.[1] !== undefined) {
      const fileId = file[1]
      if (options.unreachable?.includes(fileId)) throw new TypeError('Failed to fetch')
      if (options.missing?.includes(fileId)) return new Response('gone', { status: 404 })
      options.served?.push(fileId)
      const size = options.paddedTo?.[fileId]
      const picture = pictureOf(fileId)
      const body = size === undefined ? picture : new Uint8Array(size)
      body.set(picture)
      return new Response(body as BodyInit, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof globalThis.fetch
}

/** Connects the keeper so the record key is derivable, then caches `record`'s images. */
function cacheFor(
  record: LoroDoc,
  extra: { daemon?: DaemonOptions; budgetBytes?: number; blobs?: BlobStore } = {},
): Promise<number> {
  const fetch = daemon(record, extra.daemon)
  connectReplicaKeeper({ baseUrl: BASE, fetch })
  return cacheReplicaImages({
    fetch,
    daemonBaseUrl: BASE,
    workspaceId: DAEMON_WS,
    record,
    ...(extra.budgetBytes === undefined ? {} : { budgetBytes: extra.budgetBytes }),
    ...(extra.blobs === undefined ? {} : { blobs: extra.blobs }),
  })
}

/** Reads a Blob's text without relying on the environment's `Blob#arrayBuffer`. */
function textOf(blob: Blob | undefined): Promise<string | undefined> {
  if (blob === undefined) return Promise.resolve(undefined)
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

function withoutNode(record: LoroDoc, nodeId: string): void {
  const containers = documentContainers(record, BOARD)
  const canvas = readSpatialCanvas(containers)
  reconcileSpatialCanvas(containers, canvas, {
    ...canvas,
    nodes: canvas.nodes.filter((node) => node.id !== nodeId),
  })
  record.commit()
}

/** The real blob store, with any of its methods replaced. */
function blobStoreWith(overrides: Partial<BlobStore>): BlobStore & { deleted: BlobRef[] } {
  const real = new IdbBlobStore()
  const deleted: BlobRef[] = []
  return {
    deleted,
    put: overrides.put ?? ((input) => real.put(input)),
    get: overrides.get ?? ((input) => real.get(input)),
    has: overrides.has ?? ((input) => real.has(input)),
    delete:
      overrides.delete ??
      (async (input) => {
        deleted.push(input.ref)
        await real.delete(input)
      }),
  }
}

describe('replica images over fake-indexeddb', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    localStorage.removeItem(IMAGES_KEY)
    markReplica(DAEMON_WS, BASE)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    connectReplicaKeeper(null)
    forgetAllForTests()
    localStorage.removeItem(IMAGES_KEY)
  })

  it('caches the named pictures sealed at rest and opens them with their mime type', async () => {
    const served: string[] = []
    const cached = await cacheFor(boardNaming('img-cat'), { daemon: { served } })

    expect(cached).toBe(1)
    expect(served).toEqual(['img-cat'])
    const pointer = readReplicaImagePointer(DAEMON_WS)
    expect(pointer?.blobs).toHaveLength(1)
    expect(localStorage.getItem(IMAGES_KEY)).not.toContain('img-cat')
    const stored = await new IdbBlobStore().get({ ref: pointer!.blobs[0]! })
    expect(new TextDecoder().decode(stored!.bytes)).not.toContain('picture-plaintext')

    const loaded = (await loadReplicaImages(DAEMON_WS, ['img-cat', 'img-unknown'])).images
    expect([...loaded.keys()]).toEqual(['img-cat'])
    expect(loaded.get('img-cat')?.type).toBe('image/png')
    expect(await textOf(loaded.get('img-cat'))).toBe('picture-plaintext:img-cat')
  })

  it('a pull through cacheDaemonWorkspace files the images beside the record', async () => {
    const record = boardNaming('img-cat')
    const fetch = daemon(record)
    connectReplicaKeeper({ baseUrl: BASE, fetch })

    const result = await cacheDaemonWorkspace({
      fetch,
      daemonBaseUrl: BASE,
      workspaceId: DAEMON_WS,
      workspaceDocs: new BrowserWorkspaceDocs(),
    })

    expect(result.kind).toBe('ok')
    const loaded = (await loadReplicaImages(DAEMON_WS, ['img-cat'])).images
    expect(await textOf(loaded.get('img-cat'))).toBe('picture-plaintext:img-cat')
  })

  it('a re-pull reuses what it holds and deletes the blob of a picture no longer named', async () => {
    const record = boardNaming('img-cat', 'img-dog')
    await cacheFor(record)
    const before = readReplicaImagePointer(DAEMON_WS)?.blobs ?? []
    expect(before).toHaveLength(2)

    withoutNode(record, 'n-img-dog')
    const served: string[] = []
    const blobs = blobStoreWith({})
    const cached = await cacheFor(record, { daemon: { served }, blobs })

    expect(cached).toBe(1)
    expect(served).toEqual([])
    expect(blobs.deleted).toHaveLength(1)
    const after = readReplicaImagePointer(DAEMON_WS)?.blobs ?? []
    expect(after).toHaveLength(1)
    expect(before.map((ref) => ref.digestHex)).toContain(after[0]!.digestHex)
    expect(blobs.deleted[0]!.digestHex).not.toBe(after[0]!.digestHex)
    const loaded = (await loadReplicaImages(DAEMON_WS, ['img-cat', 'img-dog'])).images
    expect([...loaded.keys()]).toEqual(['img-cat'])
  })

  it('re-fetches a cached picture whose blob has gone missing', async () => {
    const record = boardNaming('img-cat')
    await cacheFor(record)
    const [ref] = readReplicaImagePointer(DAEMON_WS)?.blobs ?? []
    await new IdbBlobStore().delete({ ref: ref! })

    const served: string[] = []
    const cached = await cacheFor(record, { daemon: { served } })

    expect(cached).toBe(1)
    expect(served).toEqual(['img-cat'])
    const loaded = (await loadReplicaImages(DAEMON_WS, ['img-cat'])).images
    expect(await textOf(loaded.get('img-cat'))).toBe('picture-plaintext:img-cat')
  })

  it('caches what fits the budget and leaves the rest uncached', async () => {
    const cached = await cacheFor(boardNaming('img-cat', 'img-dog'), {
      budgetBytes: pictureOf('img-cat').byteLength,
    })

    expect(cached).toBe(1)
    const loaded = (await loadReplicaImages(DAEMON_WS, ['img-cat', 'img-dog'])).images
    expect([...loaded.keys()]).toEqual(['img-cat'])
  })

  it('caches a picture far past a few kilobytes under the default budget', async () => {
    // The default is sized for several full-size uploads; a budget off by a
    // factor of 1024 would cache no real photo and fail nothing else.
    const cached = await cacheFor(boardNaming('img-cat'), {
      daemon: { paddedTo: { 'img-cat': 256 * 1024 } },
    })

    expect(cached).toBe(1)
  })

  it('drops a held picture that a smaller budget no longer fits', async () => {
    const record = boardNaming('img-cat')
    await cacheFor(record)

    const cached = await cacheFor(record, { budgetBytes: 1 })

    expect(cached).toBe(0)
    expect(readReplicaImagePointer(DAEMON_WS)?.blobs).toEqual([])
    expect((await loadReplicaImages(DAEMON_WS, ['img-cat'])).images.size).toBe(0)
  })

  it('skips a picture the daemon did not serve or could not be reached for', async () => {
    const cached = await cacheFor(boardNaming('img-cat', 'img-dog', 'img-owl'), {
      daemon: { missing: ['img-dog'], unreachable: ['img-owl'] },
    })

    expect(cached).toBe(1)
    const loaded = (await loadReplicaImages(DAEMON_WS, ['img-cat', 'img-dog', 'img-owl'])).images
    expect([...loaded.keys()]).toEqual(['img-cat'])
  })

  it('files no pointer for a record that names no picture', async () => {
    const cached = await cacheFor(boardNaming())

    expect(cached).toBe(0)
    expect(readReplicaImagePointer(DAEMON_WS)).toBeUndefined()
  })

  it('caches nothing and opens nothing while the record key is not held', async () => {
    const record = boardNaming('img-cat')
    await cacheFor(record)
    connectReplicaKeeper(null)
    forgetAllForTests()
    const served: string[] = []

    const cached = await cacheReplicaImages({
      fetch: daemon(record, { served }),
      daemonBaseUrl: BASE,
      workspaceId: DAEMON_WS,
      record,
    })

    expect(cached).toBe(0)
    expect(served).toEqual([])
    expect((await loadReplicaImages(DAEMON_WS, ['img-cat'])).images.size).toBe(0)
  })

  it('an index that will not open reads as empty, so the next pull fetches afresh', async () => {
    const record = boardNaming('img-cat')
    await cacheFor(record)
    const pointer = readReplicaImagePointer(DAEMON_WS)!
    writeReplicaImagePointer(DAEMON_WS, { ...pointer, index: 'AAAAAAAAAAAA' })
    expect((await loadReplicaImages(DAEMON_WS, ['img-cat'])).images.size).toBe(0)

    const served: string[] = []
    const cached = await cacheFor(record, { daemon: { served } })

    expect(cached).toBe(1)
    expect(served).toEqual(['img-cat'])
  })

  it('an index that is not base64 at all reads as empty', async () => {
    const record = boardNaming('img-cat')
    await cacheFor(record)
    const pointer = readReplicaImagePointer(DAEMON_WS)!
    writeReplicaImagePointer(DAEMON_WS, { ...pointer, index: '%%% not base64 %%%' })

    expect((await loadReplicaImages(DAEMON_WS, ['img-cat'])).images.size).toBe(0)
  })

  it('a picture whose envelope will not open is absent while the others still load', async () => {
    await cacheFor(boardNaming('img-cat', 'img-dog'))
    const firstRef = readReplicaImagePointer(DAEMON_WS)!.blobs[0]!
    const real = new IdbBlobStore()
    const blobs = blobStoreWith({
      get: async (input) => {
        const stored = await real.get(input)
        if (stored === null) return null
        const bytes = new Uint8Array(stored.bytes)
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff
        return input.ref.digestHex === firstRef.digestHex ? { ...stored, bytes } : stored
      },
    })

    const loaded = (await loadReplicaImages(DAEMON_WS, ['img-cat', 'img-dog'], blobs)).images

    expect(loaded.size).toBe(1)
  })

  it('an envelope moved under another picture id does not open', async () => {
    await cacheFor(boardNaming('img-cat', 'img-dog'))
    const [catRef, dogRef] = readReplicaImagePointer(DAEMON_WS)?.blobs ?? []
    if (catRef === undefined || dogRef === undefined) throw new Error('two pictures not cached')
    const real = new IdbBlobStore()
    // Each read answers the OTHER picture's envelope: the same key and the
    // same record, so only the picture id in the sealing context refuses it.
    const blobs = blobStoreWith({
      get: (input) => real.get({ ref: input.ref.digestHex === catRef.digestHex ? dogRef : catRef }),
    })

    const loaded = (await loadReplicaImages(DAEMON_WS, ['img-cat', 'img-dog'], blobs)).images

    expect(loaded.size).toBe(0)
  })

  it('a picture whose blob is gone is absent from what loads', async () => {
    await cacheFor(boardNaming('img-cat'))
    const blobs = blobStoreWith({ get: async () => null })

    expect((await loadReplicaImages(DAEMON_WS, ['img-cat'], blobs)).images.size).toBe(0)
  })

  it('a refused pointer write deletes the blobs it just stored and keeps the standing ones', async () => {
    await cacheFor(boardNaming('img-cat'))
    const standing = readReplicaImagePointer(DAEMON_WS)!.blobs
    const grown = boardNaming('img-dog')
    const realSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === IMAGES_KEY) throw new DOMException('quota', 'QuotaExceededError')
      realSetItem.call(this, key, value)
    })
    const blobs = blobStoreWith({})

    const cached = await cacheFor(grown, { blobs })

    expect(cached).toBe(0)
    expect(readReplicaImagePointer(DAEMON_WS)!.blobs).toEqual(standing)
    expect(blobs.deleted).toHaveLength(1)
    expect(blobs.deleted[0]!.digestHex).not.toBe(standing[0]!.digestHex)
    expect((await new IdbBlobStore().has({ ref: standing[0]! })).exists).toBe(true)
  })
})

/** Answers the real store, but rejects each `ref` read the first `failures` times. */
function blobsFailingFirst(
  failures: number,
  match: (ref: BlobRef) => boolean,
): BlobStore & { reads: () => number } {
  const real = new IdbBlobStore()
  let reads = 0
  return {
    ...blobStoreWith({
      get: async (input) => {
        if (!match(input.ref)) return real.get(input)
        reads += 1
        if (reads <= failures) throw new DOMException('busy', 'UnknownError')
        return real.get(input)
      },
    }),
    reads: () => reads,
  }
}

/** Every call `crypto.subtle` makes to derive the record key rejects, so the lookup itself does. */
function failKeyDerivation(): void {
  forgetAllForTests()
  const refused = new Error('key derivation refused')
  vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(refused)
  vi.spyOn(crypto.subtle, 'deriveKey').mockRejectedValue(refused)
  vi.spyOn(crypto.subtle, 'deriveBits').mockRejectedValue(refused)
}

describe('a replica picture read that fails, told apart from one that is absent', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    localStorage.removeItem(IMAGES_KEY)
    markReplica(DAEMON_WS, BASE)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    connectReplicaKeeper(null)
    forgetAllForTests()
    localStorage.removeItem(IMAGES_KEY)
  })

  it('a throwing blob read is failed, while a gone blob and a damaged envelope are absent', async () => {
    await cacheFor(boardNaming('img-cat', 'img-dog'))
    const [catRef] = readReplicaImagePointer(DAEMON_WS)!.blobs
    const throwing = blobStoreWith({
      get: async () => {
        throw new DOMException('busy', 'UnknownError')
      },
    })

    const failed = await loadReplicaImages(DAEMON_WS, ['img-cat', 'img-dog'], throwing)
    expect([...failed.failed].sort()).toEqual(['img-cat', 'img-dog'])
    expect(failed.images.size).toBe(0)

    const real = new IdbBlobStore()
    const damaged = blobStoreWith({
      get: async (input) => {
        if (input.ref.digestHex !== catRef!.digestHex) return null
        const stored = await real.get(input)
        const bytes = new Uint8Array(stored!.bytes)
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff
        return { ...stored!, bytes }
      },
    })
    const absent = await loadReplicaImages(DAEMON_WS, ['img-cat', 'img-dog'], damaged)
    expect(absent.failed.size).toBe(0)
    expect(absent.images.size).toBe(0)
  })

  it('installs a picture whose read throws once and then answers', async () => {
    await cacheFor(boardNaming('img-cat', 'img-dog'))
    const [catRef] = readReplicaImagePointer(DAEMON_WS)!.blobs
    const blobs = blobsFailingFirst(1, (ref) => ref.digestHex === catRef!.digestHex)

    const loaded = await loadReplicaImagesRetrying(DAEMON_WS, ['img-cat', 'img-dog'], {
      attempts: 3,
      blobs,
    })

    expect([...loaded.keys()].sort()).toEqual(['img-cat', 'img-dog'])
    expect(blobs.reads()).toBe(2)
  })

  it('stops asking for a read that always throws after its last attempt', async () => {
    await cacheFor(boardNaming('img-cat'))
    const blobs = blobsFailingFirst(Number.POSITIVE_INFINITY, () => true)

    const loaded = await loadReplicaImagesRetrying(DAEMON_WS, ['img-cat'], { attempts: 3, blobs })

    expect(loaded.size).toBe(0)
    expect(blobs.reads()).toBe(3)
    await expectLoggedFailure('replica pictures could not be read')
  })

  it('does not ask again for a picture whose envelope will not open', async () => {
    await cacheFor(boardNaming('img-cat'))
    const real = new IdbBlobStore()
    let reads = 0
    const blobs = blobStoreWith({
      get: async (input) => {
        reads += 1
        const stored = await real.get(input)
        const bytes = new Uint8Array(stored!.bytes)
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff
        return { ...stored!, bytes }
      },
    })

    const loaded = await loadReplicaImagesRetrying(DAEMON_WS, ['img-cat'], { attempts: 3, blobs })

    expect(loaded.size).toBe(0)
    expect(reads).toBe(1)
  })

  it('a lookup that rejects answers nothing found and reports it, rather than rejecting', async () => {
    await cacheFor(boardNaming('img-cat'))
    failKeyDerivation()

    const loaded = await loadReplicaImagesRetrying(DAEMON_WS, ['img-cat'], { attempts: 3 })

    expect(loaded.size).toBe(0)
    await expectLoggedFailure('replica pictures could not be looked up')
  })

  it('a lookup that rejects once and then answers still installs', async () => {
    await cacheFor(boardNaming('img-cat'))
    forgetAllForTests()
    vi.spyOn(crypto.subtle, 'importKey').mockRejectedValueOnce(new Error('key derivation refused'))

    const loaded = await loadReplicaImagesRetrying(DAEMON_WS, ['img-cat'], { attempts: 3 })

    expect([...loaded.keys()]).toEqual(['img-cat'])
  })

  it('the clipboard seam rejects a failed read and answers undefined for an absent one', async () => {
    await cacheFor(boardNaming('img-cat'))
    const seams = replicaClipboardImages(BASE, DAEMON_WS)
    vi.spyOn(IdbBlobStore.prototype, 'get').mockRejectedValueOnce(new Error('busy'))

    await expect(seams.readImage(newImageRef('img-cat'))).rejects.toThrow()
    expect(await seams.readImage(newImageRef('img-unknown'))).toBeUndefined()
    expect(await textOf(await seams.readImage(newImageRef('img-cat')))).toBe(
      'picture-plaintext:img-cat',
    )
  })
})

describe('replica image store', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    localStorage.removeItem(IMAGES_KEY)
    markReplica(DAEMON_WS, BASE)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    connectReplicaKeeper(null)
    forgetAllForTests()
    localStorage.removeItem(IMAGES_KEY)
  })

  it('dropping a replica removes its pointer first, then its blobs', async () => {
    await cacheFor(boardNaming('img-cat'))
    const [ref] = readReplicaImagePointer(DAEMON_WS)!.blobs
    let pointerAtDelete: unknown = 'unset'
    const blobs = blobStoreWith({
      delete: async (input) => {
        pointerAtDelete = readReplicaImagePointer(DAEMON_WS)
        await new IdbBlobStore().delete(input)
      },
    })

    await dropReplicaImages(DAEMON_WS, blobs)

    expect(pointerAtDelete).toBeUndefined()
    expect(readReplicaImagePointer(DAEMON_WS)).toBeUndefined()
    expect((await new IdbBlobStore().has({ ref: ref! })).exists).toBe(false)
  })

  it('dropping a replica that has no pointer touches no blob', async () => {
    const blobs = blobStoreWith({
      delete: async () => {
        throw new Error('no blob should be deleted')
      },
    })

    await expect(dropReplicaImages(DAEMON_WS, blobs)).resolves.toBeUndefined()
  })

  it('deleting blobs carries on past one that fails', async () => {
    await cacheFor(boardNaming('img-cat', 'img-dog'))
    const refs = readReplicaImagePointer(DAEMON_WS)!.blobs
    const real = new IdbBlobStore()
    const blobs = blobStoreWith({
      delete: async (input) => {
        if (input.ref.digestHex === refs[0]!.digestHex) throw new Error('disk')
        await real.delete(input)
      },
    })

    await deleteReplicaImageBlobs(refs, blobs)

    expect((await real.has({ ref: refs[0]! })).exists).toBe(true)
    expect((await real.has({ ref: refs[1]! })).exists).toBe(false)
  })

  it('a refused pointer write answers false', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })

    expect(writeReplicaImagePointer(DAEMON_WS, { index: 'x', blobs: [] })).toBe(false)
    expect(readReplicaImagePointer(DAEMON_WS)).toBeUndefined()
  })

  it('serialises a replica through the Web Locks API under its own name when present', async () => {
    const names: string[] = []
    vi.stubGlobal('navigator', {
      ...navigator,
      locks: {
        request: (name: string, run: () => Promise<unknown>) => {
          names.push(name)
          return run()
        },
      },
    })

    const answer = await withReplicaImagesLock(DAEMON_WS, async () => 'ran')

    expect(answer).toBe('ran')
    expect(names).toEqual([`whiteboard:replica-images:${DAEMON_WS}`])
  })
})

describe('cacheDaemonWorkspace when the images cannot be stored', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    localStorage.removeItem(IMAGES_KEY)
    markReplica(DAEMON_WS, BASE)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    connectReplicaKeeper(null)
    forgetAllForTests()
    localStorage.removeItem(IMAGES_KEY)
  })

  it('still lands the record and reports the image failure', async () => {
    const record = boardNaming('img-cat')
    const fetch = daemon(record)
    connectReplicaKeeper({ baseUrl: BASE, fetch })
    vi.spyOn(IdbBlobStore.prototype, 'put').mockRejectedValue(new Error('quota'))

    const result = await cacheDaemonWorkspace({
      fetch,
      daemonBaseUrl: BASE,
      workspaceId: DAEMON_WS,
      workspaceDocs: new BrowserWorkspaceDocs(),
    })

    expect(result.kind).toBe('ok')
    await expectLoggedFailure('replica images were not cached')
    expect(readReplicaImagePointer(DAEMON_WS)).toBeUndefined()
  })
})
