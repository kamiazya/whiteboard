import {
  createWorkspaceDocumentAtPath,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentEngineTrapError } from '../document-io.js'
import { setLogSink } from '../log.js'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'

const WS = 'ws-1'

/** An update that creates one document node in a workspace tree. */
function workspaceUpdateBytes(path: string): Uint8Array {
  const doc = new LoroDoc()
  const vv0 = doc.version()
  createWorkspaceDocumentAtPath(doc, { path, documentId: generateDocumentId(), kind: 'spatial' })
  doc.commit()
  return doc.export({ mode: 'update', from: vv0 }) as Uint8Array
}

/**
 * Refusing defaults + lock-depth recording, the idiom the restore and
 * live-doc operation tests established. The lock is liveDocuments' — the
 * seam deliberately has no second lock spelling — so the double shares one
 * depth counter across both seams.
 */
function fakes() {
  const calls: { method: string; lockDepth: number }[] = []
  let lockDepth = 0
  const workspaceDoc = new LoroDoc()
  let saved = false
  let evicted = false
  let evictedBeforeUnlock = false
  const live: LiveDocuments = {
    ...unusedLiveDocuments(),
    async withWriteLock<T>(_workspaceId: string, fn: () => Promise<T>): Promise<T> {
      lockDepth += 1
      try {
        return await fn()
      } finally {
        evictedBeforeUnlock = evicted
        lockDepth -= 1
      }
    },
  }
  const workspaceDocuments: WorkspaceDocuments = {
    ...unusedWorkspaceDocuments(),
    async get(_workspaceId) {
      calls.push({ method: 'get', lockDepth })
      return workspaceDoc
    },
    async save(_workspaceId, _doc) {
      calls.push({ method: 'save', lockDepth })
      saved = true
    },
    evictProjections(_workspaceId) {
      calls.push({ method: 'evictProjections', lockDepth })
      evicted = true
    },
  }
  return {
    live,
    workspaceDocuments,
    calls,
    workspaceDoc,
    wasSaved: () => saved,
    wasEvicted: () => evicted,
    wasEvictedBeforeUnlock: () => evictedBeforeUnlock,
  }
}

/** What loro-crdt's WASM throws when a Rust panic aborts a call. */
function engineTrap(): Error {
  return Object.assign(new Error('unreachable'), { name: 'RuntimeError' })
}

/**
 * A `WorkspaceDocuments` that CACHES like the daemon's: `get` hands back the
 * same instance until `evict` drops it. What a trap must achieve is a
 * different instance on the next `get`, which only a caching double can show.
 */
function cachingWorkspaceDocuments() {
  const cache = new Map<string, LoroDoc>()
  const dropped: string[] = []
  let saves = 0
  const workspaceDocuments: WorkspaceDocuments = {
    ...unusedWorkspaceDocuments(),
    async get(workspaceId) {
      const cached = cache.get(workspaceId) ?? new LoroDoc()
      cache.set(workspaceId, cached)
      return cached
    },
    async save() {
      saves += 1
    },
    evictProjections(workspaceId) {
      dropped.push(`projections ${workspaceId}`)
    },
    evict(workspaceId) {
      dropped.push(`record ${workspaceId}`)
      cache.delete(workspaceId)
    },
  }
  const live: LiveDocuments = {
    ...unusedLiveDocuments(),
    withWriteLock: <T>(_workspaceId: string, fn: () => Promise<T>) => fn(),
  }
  return { workspaceDocuments, live, dropped, saves: () => saves }
}

const records: { level: string; msg: string; data?: Record<string, unknown> }[] = []

afterEach(() => {
  records.length = 0
  setLogSink(() => {})
  vi.restoreAllMocks()
})

describe('applyWorkspaceDocumentUpdate', () => {
  it('imports a valid update, saves, and evicts projections before the lock releases', async () => {
    const fake = fakes()
    const result = await applyWorkspaceDocumentUpdate(
      { liveDocuments: fake.live, workspaceDocuments: fake.workspaceDocuments },
      { workspaceId: WS, update: workspaceUpdateBytes('canvas-a') },
    )
    expect(result).toBe('applied')
    expect(fake.wasSaved()).toBe(true)
    expect(readWorkspaceDocuments(fake.workspaceDoc).map((d) => d.path)).toEqual(['canvas-a'])
    // Dropped INSIDE the lock: a reader grabbing a stale per-document
    // projection between import and eviction would diff old content back
    // over this import on its next save.
    expect(fake.wasEvictedBeforeUnlock()).toBe(true)
    expect(fake.calls.map((c) => c.method)).toEqual(['get', 'save', 'evictProjections'])
    for (const call of fake.calls) {
      expect(call, `${call.method} ran outside the workspace write lock`).toMatchObject({
        lockDepth: 1,
      })
    }
  })

  it('answers malformed-update for garbage bytes, saving and evicting NOTHING', async () => {
    const fake = fakes()
    const result = await applyWorkspaceDocumentUpdate(
      { liveDocuments: fake.live, workspaceDocuments: fake.workspaceDocuments },
      { workspaceId: WS, update: new Uint8Array([1, 2, 3, 4]) },
    )
    expect(result).toBe('malformed-update')
    expect(fake.wasSaved()).toBe(false)
    expect(fake.wasEvicted()).toBe(false)
  })

  it('an engine trap drops the poisoned record and its projections, and is not called malformed', async () => {
    // A trap leaves the instance holding a lock it never released, so every
    // later call on it traps too: kept cached, it takes the whole workspace
    // down until the daemon restarts.
    const fake = cachingWorkspaceDocuments()
    setLogSink((record) => records.push(record))
    const poisoned = await fake.workspaceDocuments.get(WS)
    vi.spyOn(poisoned, 'import').mockImplementation(() => {
      throw engineTrap()
    })

    const failure = await applyWorkspaceDocumentUpdate(
      { liveDocuments: fake.live, workspaceDocuments: fake.workspaceDocuments },
      { workspaceId: WS, update: workspaceUpdateBytes('canvas-a') },
    ).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(DocumentEngineTrapError)
    expect(fake.dropped).toEqual([`record ${WS}`, `projections ${WS}`])
    expect(fake.saves()).toBe(0)
    expect(await fake.workspaceDocuments.get(WS)).not.toBe(poisoned)
    expect(records).toContainEqual(
      expect.objectContaining({
        level: 'error',
        data: expect.objectContaining({ workspaceId: WS }),
      }),
    )
  })

  it('bytes the engine refuses keep the cached record', async () => {
    const fake = cachingWorkspaceDocuments()
    const cached = await fake.workspaceDocuments.get(WS)
    const result = await applyWorkspaceDocumentUpdate(
      { liveDocuments: fake.live, workspaceDocuments: fake.workspaceDocuments },
      { workspaceId: WS, update: new Uint8Array([1, 2, 3, 4]) },
    )
    expect(result).toBe('malformed-update')
    expect(fake.dropped).toEqual([])
    expect(await fake.workspaceDocuments.get(WS)).toBe(cached)
  })
})
