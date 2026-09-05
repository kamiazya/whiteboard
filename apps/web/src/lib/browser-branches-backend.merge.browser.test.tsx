/**
 * Tip adoption on the browser keeper, which is what a merge IS.
 *
 * `branchesBackendContract` deliberately stops short of this and says why:
 * nothing in the seam can give a branch a tip, so a contract case comparing
 * two tips compares two empty strings and passes against a keeper that moves
 * nothing. Here the storage is reachable, so the tip can be real — and the
 * case is the one the contract defers to, for this keeper. The daemon's half
 * lives in `mcp-node`'s branch-merge suite.
 */
import {
  frontiersToBase64,
  readBranchesFromRecord,
  writeBranchesToRecord,
} from '@kamiazya/whiteboard-history'
import {
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserBackend } from './browser-backend.js'
import { createBrowserBranchesBackend } from './browser-branches-backend.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'

claimIsolatedWhiteboardDb('browserbranchesmerge')

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

function canvasWith(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text }],
    edges: [],
  })
  doc.commit()
  return doc
}

describe('the browser keeper merges by adopting the source tip', () => {
  let backend: BrowserBackend

  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  afterEach(() => {
    backend.disconnect()
  })

  it('moves the target onto a REAL source tip, which an empty one cannot show', async () => {
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
    writeWorkspaceDocumentContent(record, documentId, canvasWith('first'))
    // A real frontier of the record, which is what a tip is. Written straight
    // onto the plane because the seam has no way to hand one over — the whole
    // reason this case is here rather than in the contract.
    const tip = frontiersToBase64(record.frontiers())
    writeBranchesToRecord(record, documentId, {
      branches: [
        { name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '2026-01-01T00:00:00.000Z' },
        {
          name: 'idea',
          tipFrontiers: tip,
          color: '#9333ea',
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      head: 'main',
    })
    await docs.save(workspaceId, record)
    expect(tip.length).toBeGreaterThan(0)

    backend = new BrowserBackend({ documentId, path: 'canvas-a', kind: 'spatial' }, docs)
    backend.connect(NO_OP_HANDLERS)
    await vi.waitFor(() => expect(backend.readRecord(() => true)).toBe(true))

    const branches = createBrowserBranchesBackend({ backend })
    await branches.merge(workspaceId, 'canvas-a', 'idea', { into: 'main', dryRun: false })

    const after = backend.readRecord((doc, id) => readBranchesFromRecord(doc, id))
    expect(after?.branches.find((b) => b.name === 'main')?.tipFrontiers).toBe(tip)
    // The source is cleaned up, as it is on the daemon: it has been absorbed.
    expect(after?.branches.map((b) => b.name)).not.toContain('idea')
  })
})
