/**
 * A purge is the moment a trashed document's images stop being named by
 * anything, so the browser keeper reclaims them then rather than at the
 * next page load. Real IndexedDB, and the images stored through the editor's
 * own upload seam, so the keys are the ones a real picture has.
 */

import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedWorkspaceDocumentContent } from '../test-utils/seed-workspace-content.js'
import { ensureBrowserWorkspace } from './browser-document-summary.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { BROWSER_FILE_ADAPTER } from './document-embed-content.js'
import { DocumentFileStore } from './document-file-store.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'

claimIsolatedWhiteboardDb('folding-browser-index-purge-sweep')

/** Past the sweep's grace window, which keeps an upload whose node is not saved yet. */
const PAST_GRACE_MS = 2 * 60 * 60 * 1000

async function uploadImage(name: string): Promise<string> {
  const stored = await BROWSER_FILE_ADAPTER.storeImage(
    new File([new Uint8Array([137, 80, 78, 71, name.length])], `${name}.png`, {
      type: 'image/png',
    }),
  )
  if (!stored.ok) throw new Error(stored.reason)
  return stored.ref
}

async function spatialDocumentShowing(index: FoldingBrowserIndex, path: string, ref: string) {
  const entry = await index.createDocument({
    workspaceId: getBrowserWorkspaceId(),
    path,
    kind: 'spatial',
  })
  const content = new LoroDoc()
  writeSpatialCanvas(content, {
    nodes: [fileNode({ id: 'img', file: ref, x: 0, y: 0, width: 10, height: 10 })],
    edges: [],
  })
  expect(
    await seedWorkspaceDocumentContent(
      entry.documentId,
      new Uint8Array(content.export({ mode: 'snapshot' })),
    ),
  ).toBe(true)
  return entry.documentId
}

describe('FoldingBrowserIndex.purgeTrashEntry', () => {
  beforeEach(clearWhiteboardDb)
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reclaims the images only the purged document named, without a reload', async () => {
    const index = new FoldingBrowserIndex()
    await ensureBrowserWorkspace(index)
    const workspaceId = getBrowserWorkspaceId()
    const doomedRef = await uploadImage('doomed')
    const keptRef = await uploadImage('kept')
    const doomedId = await spatialDocumentShowing(index, 'doomed', doomedRef)
    await spatialDocumentShowing(index, 'kept', keptRef)
    await index.deleteDocument({ workspaceId, path: 'doomed' })

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + PAST_GRACE_MS)
    expect(await index.purgeTrashEntry({ workspaceId, documentId: doomedId })).toBe(true)

    const files = new DocumentFileStore()
    await expect.poll(() => files.get(doomedRef), { timeout: 15_000 }).toBeNull()
    expect(await files.get(keptRef)).not.toBeNull()
  })
})
