/**
 * The index write barrier against a fold that keeps failing.
 *
 * The document controller's save loop is registered with the barrier for its
 * whole run, and every rename it issues asks this index for the startup fold —
 * which a failed fold leaves unsettled, so each write runs it again. If the
 * fold's own read of the legacy rows waited at the barrier, it would wait on
 * the very loop that is waiting on it: the second queued rename never lands,
 * and every listing behind the barrier hangs with it.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { expectLoggedFailures } from '../test-utils/browser-setup.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedLegacyRow } from '../test-utils/seed-legacy-row.js'
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
