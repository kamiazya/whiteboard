import {
  createWorkspaceDocumentAtPath,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
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

  it('abortIf is consulted INSIDE the lock after the read, and aborted saves nothing', async () => {
    const fake = fakes()
    let observedInsideLock: boolean | null = null
    const result = await applyWorkspaceDocumentUpdate(
      { liveDocuments: fake.live, workspaceDocuments: fake.workspaceDocuments },
      { workspaceId: WS, update: workspaceUpdateBytes('canvas-a') },
      {
        abortIf: () => {
          // The frame-race guard only means anything inside the hold: a
          // check taken before acquisition is the race it exists to close.
          observedInsideLock = fake.calls.some((c) => c.method === 'get' && c.lockDepth === 1)
          return true
        },
      },
    )
    expect(result).toBe('aborted')
    expect(observedInsideLock).toBe(true)
    expect(fake.wasSaved()).toBe(false)
    expect(fake.wasEvicted()).toBe(false)
  })

  it('onMalformed fires INSIDE the lock before malformed-update returns', async () => {
    const fake = fakes()
    let malformedLockDepth: number | null = null
    let lockDepthProbe = 0
    const live = {
      ...fake.live,
      async withWriteLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
        lockDepthProbe += 1
        try {
          return await fake.live.withWriteLock(workspaceId, fn)
        } finally {
          lockDepthProbe -= 1
        }
      },
    }
    const result = await applyWorkspaceDocumentUpdate(
      { liveDocuments: live, workspaceDocuments: fake.workspaceDocuments },
      { workspaceId: WS, update: new Uint8Array([9, 9, 9]) },
      {
        onMalformed: () => {
          malformedLockDepth = lockDepthProbe
        },
      },
    )
    expect(result).toBe('malformed-update')
    // Fired while the lock still excludes other writers, so a surface can
    // mark its socket closing before any queued frame acquires the hold.
    expect(malformedLockDepth).toBe(1)
    expect(fake.wasSaved()).toBe(false)
  })
})
