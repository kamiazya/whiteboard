/**
 * The index write barrier (`pending-index-writes.ts`) seen from a tracked
 * caller: a promise registered there that calls back into this index.
 *
 * The document controller's save loop is registered with the barrier for its
 * whole run, and every rename it issues asks this index for the startup fold —
 * which a failed fold leaves unsettled, so each write runs it again. If the
 * fold's own read of the legacy rows waited at the barrier, it would wait on
 * the very loop that is waiting on it: the second queued rename never lands,
 * and every listing behind the barrier hangs with it.
 *
 * The same holds for every method but the three document reads: each is
 * called here from a tracked promise, after an await so the promise is
 * already registered, and must settle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { expectLoggedFailures } from '../test-utils/browser-setup.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedLegacyRow } from '../test-utils/seed-legacy-row.js'
import { seedSyncDocument } from '../test-utils/seed-sync-document.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { LoroStore } from './loro-store.js'
import { trackIndexWrite } from './pending-index-writes.js'

claimIsolatedWhiteboardDb('folding-browser-index-write-barrier')

beforeEach(clearWhiteboardDb)
afterEach(() => {
  vi.restoreAllMocks()
})

/** Whether `promise` has settled, polled rather than awaited so a hang fails. */
function settles(promise: Promise<unknown>): () => boolean {
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  return () => settled
}

it('a tracked save loop and a later listing settle while every fold fails', async () => {
  const logged = expectLoggedFailures()
  const workspaceId = getBrowserWorkspaceId()
  await new IdbDocumentIndex().createWorkspace({ workspaceId })
  const { documentId } = await new FoldingBrowserIndex().createDocument({
    workspaceId,
    path: 'note',
    kind: 'markdown',
  })
  // An unfolded row whose record cannot be read by a throw: every fold from
  // here on fails, and nothing settles the memo.
  await seedLegacyRow({ workspaceId, path: 'old', kind: 'markdown' })
  vi.spyOn(LoroStore.prototype, 'load').mockRejectedValue(new Error('injected fold failure'))

  const index = new FoldingBrowserIndex()
  await index.listDocuments({ workspaceId })

  // The controller's loop: tracked for its whole run, the second queued
  // rename issued after an await, when the loop is already registered.
  const loop = trackIndexWrite(
    (async () => {
      await index.setDocumentName({ workspaceId, documentId, name: 'A' })
      await index.setDocumentName({ workspaceId, documentId, name: 'AB' })
    })(),
  )
  await expect.poll(settles(loop), { timeout: 5000 }).toBe(true)
  await loop

  const listing = index.listDocuments({ workspaceId })
  await expect.poll(settles(listing), { timeout: 5000 }).toBe(true)
  expect((await listing).find((entry) => entry.documentId === documentId)?.name).toBe('AB')
  expect(logged.join('\n')).toContain('[folding-browser-index] startup fold failed')
})

interface TrackedCase {
  readonly method: string
  readonly call: (fixture: Fixture) => Promise<unknown>
}

interface Fixture {
  readonly index: FoldingBrowserIndex
  readonly workspaceId: string
  readonly documentId: string
  readonly trashedId: string
}

const trackedCases: readonly TrackedCase[] = [
  {
    method: 'createWorkspace',
    call: ({ index, workspaceId }) => index.createWorkspace({ workspaceId }),
  },
  {
    method: 'renameWorkspace',
    call: ({ index, workspaceId }) =>
      index.renameWorkspace({ workspaceId, displayName: 'Renamed' }),
  },
  { method: 'listWorkspaces', call: ({ index }) => index.listWorkspaces() },
  {
    method: 'resolveWorkspace',
    call: ({ index, workspaceId }) => index.resolveWorkspace(workspaceId),
  },
  {
    method: 'createDocument',
    call: ({ index, workspaceId }) =>
      index.createDocument({ workspaceId, path: 'other', kind: 'markdown' }),
  },
  {
    method: 'duplicateDocument',
    call: ({ index, workspaceId }) => index.duplicateDocument({ workspaceId, path: 'note' }),
  },
  {
    method: 'restoreDocument',
    call: ({ index, workspaceId, trashedId }) =>
      index.restoreDocument({ workspaceId, documentId: trashedId }),
  },
  {
    method: 'deleteDocument',
    call: ({ index, workspaceId }) => index.deleteDocument({ workspaceId, path: 'note' }),
  },
  {
    method: 'deleteDocument (fold-skipped)',
    call: ({ index, workspaceId }) => index.deleteDocument({ workspaceId, path: 'damaged' }),
  },
  {
    method: 'moveDocument',
    call: ({ index, workspaceId }) =>
      index.moveDocument({ workspaceId, from: 'note', to: 'moved' }),
  },
  {
    method: 'setDocumentName',
    call: ({ index, workspaceId, documentId }) =>
      index.setDocumentName({ workspaceId, documentId, name: 'A' }),
  },
  {
    method: 'setDocumentPinned',
    call: ({ index, workspaceId, documentId }) =>
      index.setDocumentPinned({ workspaceId, documentId, pinned: true }),
  },
  {
    method: 'listPinnedDocuments',
    call: ({ index, workspaceId }) => index.listPinnedDocuments({ workspaceId }),
  },
  { method: 'listTrash', call: ({ index, workspaceId }) => index.listTrash({ workspaceId }) },
  {
    method: 'purgeTrashEntry',
    call: ({ index, workspaceId, trashedId }) =>
      index.purgeTrashEntry({ workspaceId, documentId: trashedId }),
  },
]

describe('called from a tracked promise', () => {
  it.each(trackedCases)('$method settles', async ({ call }) => {
    expectLoggedFailures()
    const workspaceId = getBrowserWorkspaceId()
    await new IdbDocumentIndex().createWorkspace({ workspaceId })
    // A row the fold skips: an envelope from a build this one does not know.
    const damaged = await seedLegacyRow({ workspaceId, path: 'damaged', kind: 'markdown' })
    await seedSyncDocument(damaged.documentId, { raw: { v: 99 } })
    const index = new FoldingBrowserIndex()
    const { documentId } = await index.createDocument({
      workspaceId,
      path: 'note',
      kind: 'markdown',
    })
    const trashed = await index.createDocument({ workspaceId, path: 'gone', kind: 'markdown' })
    await index.deleteDocument({ workspaceId, path: 'gone' })
    const fixture = { index, workspaceId, documentId, trashedId: trashed.documentId }

    // A call that hangs leaves its tracked promise outstanding, and every
    // later read in this page would wait on it; the release unblocks the
    // barrier so one failing method cannot fail the cases after it.
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const called = (async () => {
      await Promise.resolve()
      return call(fixture)
    })()
    const tracked = trackIndexWrite(Promise.race([called, released]))
    try {
      await expect.poll(settles(called), { timeout: 3000 }).toBe(true)
      await called
    } finally {
      release()
      await tracked
    }
  })
})

it('a document listing waits for a rename queued before it', async () => {
  const workspaceId = getBrowserWorkspaceId()
  const index = new FoldingBrowserIndex()
  await index.createWorkspace({ workspaceId })
  const { documentId } = await index.createDocument({ workspaceId, path: 'note', kind: 'markdown' })
  let issue = () => {}
  const gate = new Promise<void>((resolve) => {
    issue = resolve
  })
  // Queued, not issued: the save loop holding a keystroke behind the one in flight.
  const queued = trackIndexWrite(
    (async () => {
      await gate
      await index.setDocumentName({ workspaceId, documentId, name: 'Late' })
    })(),
  )

  const listing = index.listDocuments({ workspaceId })
  // A whole IndexedDB round trip, so a listing that did not wait has answered.
  await new IdbDocumentIndex(undefined, { readsAwaitIssuedWrites: false }).listWorkspaces()
  issue()

  expect((await listing).find((entry) => entry.documentId === documentId)?.name).toBe('Late')
  await queued
})
