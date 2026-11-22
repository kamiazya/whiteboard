/**
 * The live workspace-record cache is bounded: one process serves every
 * workspace it is asked for, and every record it keeps shares one WASM heap.
 *
 * Residency is observed through instance identity — a hit answers the cached
 * record, a reopen answers a new one — because that is what a caller can
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
import { textNode, workspaceIdFor } from '@kamiazya/whiteboard-model/test-utils'
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
  _clearWorkspaceDocCacheForTests,
  _heldWorkspaceRecordForTests,
  evictWorkspaceDocCache,
  workspaceDocCacheMaxEntries,
} = await import('./workspace-doc-cache.js')
const { editWorkspaceRecord, storedWorkspaceRecordCopy, workspaceRecordCopy } = await import(
  './_test-workspace-record.js'
)
const { loadDocument, saveDocument, onWorkspaceDocUpdated } = await import('./document-store.js')
const { getDb } = await import('./db/index.js')
const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { withWorkspaceWriteLock, workspaceWriteLockInUse, _resetWorkspaceLocksForTests } =
  await import('./workspace-lock.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

const ws = (i: number) => workspaceIdFor(`ws-lru-${i}`)

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ws-doc-lru-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  _clearWorkspaceDocCacheForTests()
  _resetWorkspaceLocksForTests()
})
afterEach(async () => {
  _clearWorkspaceDocCacheForTests()
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

/** What the cache holds for a workspace, an instance a caller can tell apart from a reopened one. */
function heldRecord(workspaceId: string): object {
  const held = _heldWorkspaceRecordForTests(workspaceId)
  if (held === undefined) throw new Error(`no record is held for ${workspaceId}`)
  return held
}

/** Opens (minting when nothing is stored) the workspace's record and answers the instance the cache holds. */
async function openHeld(workspaceId: string): Promise<object> {
  await workspaceRecordCopy(workspaceId)
  return heldRecord(workspaceId)
}

/** Reads the workspace's stored record and answers the instance the cache holds afterwards, if any. */
async function reopenHeld(workspaceId: string): Promise<object | undefined> {
  await storedWorkspaceRecordCopy(workspaceId)
  return _heldWorkspaceRecordForTests(workspaceId)
}

/** Opens workspaces `from..to-1`, answering each instance in order. */
async function openRange(from: number, to: number): Promise<object[]> {
  const docs: object[] = []
  for (let i = from; i < to; i += 1) docs.push(await openHeld(ws(i)))
  return docs
}

describe('the workspace-record cache bound', () => {
  it('keeps at most the bound resident, dropping the least recently used', async () => {
    const N = workspaceDocCacheMaxEntries()
    expect(N).toBeGreaterThan(1)
    const opened = await openRange(0, N + 1)

    // Newest first, so every check is a hit on an entry already most-recent
    // relative to the ones still to be checked — no check evicts another.
    for (let i = N; i >= 1; i -= 1) {
      expect(await openHeld(ws(i))).toBe(opened[i])
    }
    expect(await openHeld(ws(0))).not.toBe(opened[0])
  })

  it('counts a hit as a use, so a touched record outlives an untouched one', async () => {
    const N = workspaceDocCacheMaxEntries()
    const opened = await openRange(0, N)
    expect(await openHeld(ws(0))).toBe(opened[0])

    await openHeld(ws(N))

    expect(await reopenHeld(ws(0))).toBe(opened[0])
    expect(await reopenHeld(ws(1))).not.toBe(opened[1])
  })

  it('reopens an evicted record with the same content and frontier', async () => {
    const N = workspaceDocCacheMaxEntries()
    await editWorkspaceRecord(ws(0), (record) => record.getMap('probe').set('k', 'v'))
    const first = heldRecord(ws(0))
    const before = await workspaceRecordCopy(ws(0))
    const content = before.toJSON()
    const frontier = before.oplogVersion()

    await openRange(1, N + 1)
    const reopened = await openHeld(ws(0))
    const after = await workspaceRecordCopy(ws(0))

    expect(reopened).not.toBe(first)
    expect(after.toJSON()).toEqual(content)
    expect(after.oplogVersion().compare(frontier)).toBe(0)
  })

  it('never evicts a record whose write lock is held', async () => {
    const N = workspaceDocCacheMaxEntries()
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let held!: object
    let seenAfter!: object
    let holder!: Promise<void>
    const entered = new Promise<void>((resolveEntered) => {
      holder = withWorkspaceWriteLock(ws(0), async () => {
        // An edit not yet saved: exactly what an eviction here would lose.
        await editWorkspaceRecord(
          ws(0),
          (record) => record.getMap('probe').set('unsaved', true),
          undefined,
          {
            save: false,
          },
        )
        held = heldRecord(ws(0))
        resolveEntered()
        await released
        seenAfter = await openHeld(ws(0))
        await editWorkspaceRecord(ws(0), () => {})
      })
    })
    await entered

    await openRange(1, N + 2)
    release()
    await holder

    expect(seenAfter).toBe(held)
    expect((await workspaceRecordCopy(ws(0))).getMap('probe').get('unsaved')).toBe(true)
  })

  it('drops a record once its lock is released and it is least recently used', async () => {
    const N = workspaceDocCacheMaxEntries()
    let held!: object
    await withWorkspaceWriteLock(ws(0), async () => {
      held = await openHeld(ws(0))
      await openRange(1, N + 1)
    })
    // The lock's queue entry clears a few microtasks after the holder
    // returns; until then the record still counts as in use.
    await vi.waitFor(() => expect(workspaceWriteLockInUse(ws(0))).toBe(false))

    await openHeld(ws(N + 1))

    expect(await reopenHeld(ws(0))).not.toBe(held)
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
  return textOf(await loadDocument(workspaceId, path))
}

describe('a dropped workspace record and what was derived from it', () => {
  it('serves a foreign edit made while the record was out of the cache', async () => {
    await saveDocument(ws(0), 'd', canvasDoc('before'), { kind: 'spatial' })
    expect(textOf(await loadDocument(ws(0), 'd'))).toBe('before')

    await openRange(1, workspaceDocCacheMaxEntries() + 1)
    await foreignEdit(ws(0), 'd', 'after')

    const served = await loadDocument(ws(0), 'd')
    expect(textOf(served)).toBe('after')
    await saveDocument(ws(0), 'd', served, { overwrite: true })
    expect(await storedText(ws(0), 'd')).toBe('after')
  })

  it('announces a foreign edit made while the record was out of the cache', async () => {
    await saveDocument(ws(0), 'd', canvasDoc('before'), { kind: 'spatial' })
    const replica = await workspaceRecordCopy(ws(0))
    const off = onWorkspaceDocUpdated((workspaceId, update) => {
      if (workspaceId === ws(0)) replica.import(update)
    })
    try {
      await openRange(1, workspaceDocCacheMaxEntries() + 1)
      await foreignEdit(ws(0), 'd', 'after')

      const reopened = await workspaceRecordCopy(ws(0))

      expect(replica.version().compare(reopened.version())).toBe(0)
    } finally {
      off()
    }
  })

  // An explicit eviction may drop ops storage refused, so a version
  // remembered from an earlier drop must not be announced from either.
  it('announces nothing on reopen once an explicit eviction followed the drop', async () => {
    await saveDocument(ws(0), 'd', canvasDoc('before'), { kind: 'spatial' })
    await openRange(1, workspaceDocCacheMaxEntries() + 1)
    evictWorkspaceDocCache(ws(0))
    const announced: string[] = []
    const off = onWorkspaceDocUpdated((workspaceId) => {
      if (workspaceId === ws(0)) announced.push(workspaceId)
    })
    try {
      await foreignEdit(ws(0), 'd', 'after')
      await workspaceRecordCopy(ws(0))

      expect(announced).toEqual([])
    } finally {
      off()
    }
  })
})

describe('the bound after a write lock releases', () => {
  it('trims back to the bound on the next access once locks release', async () => {
    const N = workspaceDocCacheMaxEntries()
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const held: object[] = []
    const entered: Promise<void>[] = []
    const holders: Promise<void>[] = []
    for (let i = 0; i < N; i += 1) {
      entered.push(
        new Promise<void>((resolveEntered) => {
          holders.push(
            withWorkspaceWriteLock(ws(i), async () => {
              held[i] = await openHeld(ws(i))
              resolveEntered()
              await released
            }),
          )
        }),
      )
    }
    await Promise.all(entered)
    // Every resident record is locked, so this one runs the cache over the bound.
    const extra = await openHeld(ws(N))
    release()
    await Promise.all(holders)
    await vi.waitFor(() => expect(workspaceWriteLockInUse(ws(0))).toBe(false))

    expect(await openHeld(ws(N))).toBe(extra)

    expect(await reopenHeld(ws(0))).not.toBe(held[0])
  })
})
