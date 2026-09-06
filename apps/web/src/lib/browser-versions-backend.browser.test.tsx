import { writeBranchesToRecord } from '@kamiazya/whiteboard-history'
import {
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserBackend } from './browser-backend.js'
import { BrowserVersionStore } from './browser-version-store.js'
import { createBrowserVersionsBackend } from './browser-versions-backend.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'

claimIsolatedWhiteboardDb('browserversionsbackend')

const NO_OP_HANDLERS = {
  onSnapshot: () => {},
  onRemoteUpdate: () => {},
  onConnected: () => {},
  onDisconnected: () => {},
  onRestoreStarted: () => {},
  onRestoreComplete: () => {},
  onVersionCreated: () => {},
  onHeadChanged: () => {},
  onViewportRequest: () => {},
  onExportRequest: () => {},
}

/**
 * What the shared `versionsBackendContract` cannot express, so it lives here
 * with the keeper it belongs to: the seam's `save` carries a label and
 * nothing else, and which VARIATION a manual save lands on is the keeper's
 * to resolve — the daemon's route reads HEAD before writing the row, and
 * this is the browser's half of that.
 */
describe('the browser versions backend files a manual save on the current variation', () => {
  let backend: BrowserBackend

  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  afterEach(() => {
    backend.disconnect()
  })

  it('records the variation HEAD is on, not the default', async () => {
    const workspaceId = getBrowserWorkspaceId()
    const index = new FoldingBrowserIndex()
    await index.createWorkspace({ workspaceId })
    const { documentId } = await index.createDocument({
      workspaceId,
      path: 'canvas-a',
      kind: 'spatial',
    })

    const docs = new BrowserWorkspaceDocs()
    const record = await docs.open(workspaceId)
    if (record === null) throw new Error('no record')
    const content = new LoroDoc()
    writeSpatialCanvas(content, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'work' }],
      edges: [],
    })
    content.commit()
    writeWorkspaceDocumentContent(record, documentId, content)
    // A NON-default HEAD, which is the whole point: `main` is also what a row
    // carrying no variation reads as, so a save taken there cannot tell a
    // resolved value from an unresolved one.
    writeBranchesToRecord(record, documentId, {
      branches: [
        { name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '2026-01-01T00:00:00.000Z' },
        { name: 'idea', tipFrontiers: '', color: '#9333ea', createdAt: '2026-01-02T00:00:00.000Z' },
      ],
      head: 'idea',
    })
    await docs.save(workspaceId, record)

    backend = new BrowserBackend({ documentId, path: 'canvas-a', kind: 'spatial' }, docs)
    backend.connect(NO_OP_HANDLERS)
    await vi.waitFor(() => expect(backend.readRecord(() => true)).toBe(true))

    const store = new BrowserVersionStore({ docs, index })
    const versions = createBrowserVersionsBackend({ record: backend, store, kind: 'spatial' })
    await versions.save(workspaceId, 'canvas-a', { label: 'by hand' })

    expect(await store.list(workspaceId, 'canvas-a')).toEqual([
      expect.objectContaining({ label: 'by hand', auto: false, branchName: 'idea' }),
    ])
  })
})
