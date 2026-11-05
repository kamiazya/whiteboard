/**
 * The browser keeper's trash listing carries what the folders above a deleted
 * document were called: once its folder is emptied, nothing else can say.
 */
import 'fake-indexeddb/auto'
import { Loro } from 'loro-crdt'
import { beforeEach, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedWorkspaceDocumentContent } from '../test-utils/seed-workspace-content.js'
import { ensureBrowserWorkspace } from './browser-document-summary.js'
import { createBrowserFilesSource } from './browser-files-source.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'

claimIsolatedWhiteboardDb('browser-files-source-trash-folders')

beforeEach(clearWhiteboardDb)

it('lists the names of the folders a deleted document stood in', async () => {
  const index = new FoldingBrowserIndex()
  await ensureBrowserWorkspace(index)
  const entry = await index.createDocument({
    workspaceId: getBrowserWorkspaceId(),
    path: 'field-trips/trip-log',
    kind: 'markdown',
  })
  await seedWorkspaceDocumentContent(entry.documentId, new Loro().export({ mode: 'snapshot' }))
  const source = createBrowserFilesSource({ index })
  await source.setFolderName?.('field-trips', 'Field trips')
  await index.deleteDocument({ workspaceId: getBrowserWorkspaceId(), path: 'field-trips/trip-log' })

  const trash = await source.listTrash?.()
  expect(trash?.[0]?.folderNames).toEqual([{ path: 'field-trips', name: 'Field trips' }])
})
