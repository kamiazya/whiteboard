/**
 * What the daemon owes a workspace record it holds: the store's operations
 * answer, a write another process makes is served and announced, the bound and
 * the idle time give records back, and nothing stays on loan.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceDocumentAtPath } from '@kamiazya/whiteboard-loro-adapter'
import { workspaceIdFor } from '@kamiazya/whiteboard-model/test-utils'
import { RecordStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEASE_IDLE_MS } from './workspace-record-kind.js'

let tempDir: string
vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const store = await import('./document-store.js')
const cache = await import('./workspace-doc-cache.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { getDb } = await import('./db/index.js')
const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
const { globalStoreScope } = await import('./store-scope.js')
const { loroDocKind } = await import('@kamiazya/whiteboard-loro-adapter')
const { writeSpatialCanvas } = await import('@kamiazya/whiteboard-loro-adapter')
const { textNode } = await import('@kamiazya/whiteboard-model/test-utils')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
const ws = (i: number) => workspaceIdFor(`ws-kinds-${i}`)

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ws-kinds-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  cache._clearWorkspaceDocCacheForTests()
})
afterEach(async () => {
  cache._clearWorkspaceDocCacheForTests()
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

function canvas(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 80, height: 40, text })],
    edges: [],
  })
  return doc
}

/** Another process's write: its own copy of the stored record, saved straight to the store. */
async function foreignWrite(workspaceId: string, path: string, documentId: string): Promise<void> {
  const docs = new RecordStoreWorkspaceDocs(
    new LibsqlDocumentStore(await getDb(tempDir)),
    loroDocKind,
  )
  const record = (await docs.open(workspaceId)) ?? (await loroDocKind.empty())
  createWorkspaceDocumentAtPath(record, { path, documentId, kind: 'markdown' })
  record.commit()
  await docs.save(workspaceId, record)
}

const paths = async (workspaceId: string) =>
  (await store.listDocuments(workspaceId)).map((entry) => entry.path).sort()

describe('the store', () => {
  it('saves, lists, renames, loads and deletes a document, and leaves nothing on loan', async () => {
    await store.saveDocument(ws(0), 'a', canvas('hello'), { kind: 'spatial' })
    await store.saveDocument(ws(0), 'dir/b', canvas('there'), { kind: 'spatial' })
    expect(await paths(ws(0))).toEqual(['a', 'dir/b'])

    await store.renameDocumentPath(ws(0), 'a', 'c')
    expect(await paths(ws(0))).toEqual(['c', 'dir/b'])
    expect(JSON.stringify((await store.loadDocument(ws(0), 'c')).toJSON())).toContain('hello')

    expect(await store.deleteDocument(ws(0), 'c')).toBe(true)
    expect(await paths(ws(0))).toEqual(['dir/b'])
    expect(cache._workspaceRecordLoansForTests()).toBe(0)
  })

  it('serves and announces a document another process placed', async () => {
    await store.saveDocument(ws(0), 'a', canvas('mine'), { kind: 'spatial' })
    const heard: Uint8Array[] = []
    const stop = cache.onWorkspaceDocUpdated((_id, update) => heard.push(update))
    await foreignWrite(ws(0), 'theirs', '01ARZ3NDEKTSV4RRFFQ69G5FAV')

    expect(await paths(ws(0))).toEqual(['a', 'theirs'])
    stop()
    expect(heard.length).toBeGreaterThan(0)
  })

  it('announces what arrived while the bound had dropped the record', async () => {
    const releases = cache._workspaceRecordReleasesForTests()
    await store.saveDocument(ws(0), 'a', canvas('mine'), { kind: 'spatial' })
    for (let i = 1; i <= cache.workspaceDocCacheMaxEntries(); i++) {
      await store.saveDocument(ws(i), 'x', canvas('x'), { kind: 'spatial' })
    }
    expect(releases.length).toBeGreaterThan(0)
    await foreignWrite(ws(0), 'theirs', '01ARZ3NDEKTSV4RRFFQ69G5FAV')
    const heard: Uint8Array[] = []
    const stop = cache.onWorkspaceDocUpdated((_id, update) => heard.push(update))

    expect(await paths(ws(0))).toEqual(['a', 'theirs'])
    stop()
    expect(heard.length).toBeGreaterThan(0)
  })

  it('reads the persisted record without what a bracket has written and not saved', async () => {
    await store.saveDocument(ws(0), 'a', canvas('mine'), { kind: 'spatial' })
    const seen = await cache.withWorkspaceRecord(ws(0), globalStoreScope, async (record) => {
      record.write([
        {
          op: 'createWorkspaceDocumentAtPath',
          args: { path: 'unsaved', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAW', kind: 'markdown' },
        },
      ])
      return cache.withPersistedWorkspaceRecord(ws(0), globalStoreScope, async (persisted) =>
        persisted === null
          ? []
          : (
              await persisted.read(
                { query: 'documents' },
                { parse: (v) => v as { path: string }[] },
              )
            ).map((entry) => entry.path),
      )
    })

    expect(seen).toEqual(['a'])
    expect(cache._workspaceRecordLoansForTests()).toBe(0)
  })
})

describe('a record nobody uses', () => {
  let next = 100
  const nextWorkspace = () => {
    next += 1
    return next
  }
  const idleReleases = async (armed: boolean) => {
    const { recordIdleReleaseWorker } = await import('./record-idle-release.js')
    if (armed) recordIdleReleaseWorker.start()
    const releases = cache._workspaceRecordReleasesForTests()
    // Faked before the save: the wait is armed by the record being kept.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      await store.saveDocument(ws(nextWorkspace()), 'a', canvas('mine'), { kind: 'spatial' })
      const before = releases.length
      await vi.advanceTimersByTimeAsync(LEASE_IDLE_MS + 1)
      return releases.length - before
    } finally {
      vi.useRealTimers()
      await recordIdleReleaseWorker.stop()
    }
  }

  it('is given back after the idle time when the worker is armed', async () => {
    expect(await idleReleases(true)).toBe(1)
  })

  it('is kept when the worker is not armed', async () => {
    expect(await idleReleases(false)).toBe(0)
  })
})
