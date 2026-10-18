/**
 * The live workspace-record cache is bounded: one process serves every
 * workspace it is asked for, and every record it keeps shares one WASM heap.
 *
 * Residency is observed through instance identity — a hit answers the cached
 * `LoroDoc`, a reopen answers a new one — because that is what a caller can
 * tell apart, and what an eviction that loses state would change.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readSpatialCanvas,
  resolveWorkspaceDocument,
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { nodeText } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string
vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const {
  getWorkspaceDoc,
  openWorkspaceDocIfStored,
  saveWorkspaceDoc,
  _clearWorkspaceDocCacheForTests,
  WORKSPACE_DOC_CACHE_MAX_ENTRIES,
} = await import('./workspace-doc-cache.js')
const { clearDocCacheForTests } = await import('./doc-cache.js')
const { getDoc, saveDocument, onWorkspaceDocUpdated } = await import('./document-store.js')
const { getDb } = await import('./db/index.js')
const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { withWorkspaceWriteLock, workspaceWriteLockInUse, _resetWorkspaceLocksForTests } =
  await import('./workspace-lock.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

const ws = (i: number) => `ws-lru-${i}`

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ws-doc-lru-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
  _resetWorkspaceLocksForTests()
})
afterEach(async () => {
  _clearWorkspaceDocCacheForTests()
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

/** Opens workspaces `from..to-1`, answering each instance in order. */
async function openRange(from: number, to: number): Promise<LoroDoc[]> {
  const docs: LoroDoc[] = []
  for (let i = from; i < to; i += 1) docs.push(await getWorkspaceDoc(ws(i)))
  return docs
}

describe('the workspace-record cache bound', () => {
  it('keeps at most the bound resident, dropping the least recently used', async () => {
    const N = WORKSPACE_DOC_CACHE_MAX_ENTRIES
    expect(N).toBeGreaterThan(1)
    const opened = await openRange(0, N + 1)

    // Newest first, so every check is a hit on an entry already most-recent
    // relative to the ones still to be checked — no check evicts another.
    for (let i = N; i >= 1; i -= 1) {
      expect(await getWorkspaceDoc(ws(i))).toBe(opened[i])
    }
    expect(await getWorkspaceDoc(ws(0))).not.toBe(opened[0])
  })

  it('counts a hit as a use, so a touched record outlives an untouched one', async () => {
    const N = WORKSPACE_DOC_CACHE_MAX_ENTRIES
    const opened = await openRange(0, N)
    expect(await getWorkspaceDoc(ws(0))).toBe(opened[0])

    await getWorkspaceDoc(ws(N))

    expect(await openWorkspaceDocIfStored(ws(0))).toBe(opened[0])
    expect(await openWorkspaceDocIfStored(ws(1))).not.toBe(opened[1])
  })

  it('reopens an evicted record with the same content and frontier', async () => {
    const N = WORKSPACE_DOC_CACHE_MAX_ENTRIES
    const first = await getWorkspaceDoc(ws(0))
    first.getMap('probe').set('k', 'v')
    first.commit()
    await saveWorkspaceDoc(ws(0), first)
    const content = first.toJSON()
    const frontier = first.oplogVersion()

    await openRange(1, N + 1)
    const reopened = await getWorkspaceDoc(ws(0))

    expect(reopened).not.toBe(first)
    expect(reopened.toJSON()).toEqual(content)
    expect(reopened.oplogVersion().compare(frontier)).toBe(0)
  })

  it('never evicts a record whose write lock is held', async () => {
    const N = WORKSPACE_DOC_CACHE_MAX_ENTRIES
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let held!: LoroDoc
    let seenAfter!: LoroDoc
    let holder!: Promise<void>
    const entered = new Promise<void>((resolveEntered) => {
      holder = withWorkspaceWriteLock(ws(0), async () => {
        held = await getWorkspaceDoc(ws(0))
        // An edit not yet saved: exactly what an eviction here would lose.
        held.getMap('probe').set('unsaved', true)
        held.commit()
        resolveEntered()
        await released
        seenAfter = await getWorkspaceDoc(ws(0))
        await saveWorkspaceDoc(ws(0), seenAfter)
      })
    })
    await entered

    await openRange(1, N + 2)
    release()
    await holder

    expect(seenAfter).toBe(held)
    expect(seenAfter.getMap('probe').get('unsaved')).toBe(true)
  })

  it('drops a record once its lock is released and it is least recently used', async () => {
    const N = WORKSPACE_DOC_CACHE_MAX_ENTRIES
    let held!: LoroDoc
    await withWorkspaceWriteLock(ws(0), async () => {
      held = await getWorkspaceDoc(ws(0))
      await openRange(1, N + 1)
    })
    // The lock's queue entry clears a few microtasks after the holder
    // returns; until then the record still counts as in use.
    await vi.waitFor(() => expect(workspaceWriteLockInUse(ws(0))).toBe(false))

    await getWorkspaceDoc(ws(N + 1))

    expect(await openWorkspaceDocIfStored(ws(0))).not.toBe(held)
  })
})

function canvasDoc(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 80, height: 40, text })],
    edges: [],
  })
  return doc
}

function textOf(doc: LoroDoc): string | null {
  const node = readSpatialCanvas(doc).nodes[0]
  return node === undefined ? null : (nodeText(node) ?? null)
}

/** A second process over the same data dir: a store this module's cache never sees. */
function foreignDocs(): Promise<DocumentStoreWorkspaceDocs> {
  return getDb(tempDir).then((db) => new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(db)))
}

async function foreignEdit(workspaceId: string, path: string, text: string): Promise<void> {
  const docs = await foreignDocs()
  const record = await docs.open(workspaceId)
  if (record === null) throw new Error(`no record for ${workspaceId}`)
  const entry = resolveWorkspaceDocument(record, path)
  if (entry === null) throw new Error(`no document at ${path}`)
  writeWorkspaceDocumentContent(record, entry.documentId, canvasDoc(text))
  record.commit()
  await docs.save(workspaceId, record)
}

async function storedText(workspaceId: string, path: string): Promise<string | null> {
  _clearWorkspaceDocCacheForTests()
  clearDocCacheForTests()
  return textOf(await getDoc(workspaceId, path))
}

describe('a dropped workspace record and what was derived from it', () => {
  it('serves a foreign edit made while the record was out of the cache', async () => {
    await saveDocument(ws(0), 'd', canvasDoc('before'), { kind: 'spatial' })
    expect(textOf(await getDoc(ws(0), 'd'))).toBe('before')

    await openRange(1, WORKSPACE_DOC_CACHE_MAX_ENTRIES + 1)
    await foreignEdit(ws(0), 'd', 'after')

    const served = await getDoc(ws(0), 'd')
    expect(textOf(served)).toBe('after')
    await saveDocument(ws(0), 'd', served, { overwrite: true })
    expect(await storedText(ws(0), 'd')).toBe('after')
  })

  it('announces a foreign edit made while the record was out of the cache', async () => {
    await saveDocument(ws(0), 'd', canvasDoc('before'), { kind: 'spatial' })
    const replica = new LoroDoc()
    replica.import((await getWorkspaceDoc(ws(0))).export({ mode: 'snapshot' }))
    const off = onWorkspaceDocUpdated((workspaceId, update) => {
      if (workspaceId === ws(0)) replica.import(update)
    })
    try {
      await openRange(1, WORKSPACE_DOC_CACHE_MAX_ENTRIES + 1)
      await foreignEdit(ws(0), 'd', 'after')

      const reopened = await getWorkspaceDoc(ws(0))

      expect(replica.version().compare(reopened.version())).toBe(0)
    } finally {
      off()
    }
  })
})

describe('the bound after a write lock releases', () => {
  it('trims back to the bound on the next access once locks release', async () => {
    const N = WORKSPACE_DOC_CACHE_MAX_ENTRIES
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const held: LoroDoc[] = []
    const entered: Promise<void>[] = []
    const holders: Promise<void>[] = []
    for (let i = 0; i < N; i += 1) {
      entered.push(
        new Promise<void>((resolveEntered) => {
          holders.push(
            withWorkspaceWriteLock(ws(i), async () => {
              held[i] = await getWorkspaceDoc(ws(i))
              resolveEntered()
              await released
            }),
          )
        }),
      )
    }
    await Promise.all(entered)
    // Every resident record is locked, so this one runs the cache over the bound.
    const extra = await getWorkspaceDoc(ws(N))
    release()
    await Promise.all(holders)
    await vi.waitFor(() => expect(workspaceWriteLockInUse(ws(0))).toBe(false))

    expect(await getWorkspaceDoc(ws(N))).toBe(extra)

    expect(await openWorkspaceDocIfStored(ws(0))).not.toBe(held[0])
  })
})
