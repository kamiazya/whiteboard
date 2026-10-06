/**
 * BrowserBackend placing a document the fold never took, from a legacy record
 * whose last edits sit in its delta log rather than its snapshot.
 *
 * Real IndexedDB and real Loro wasm: the record is written through the real
 * document store, snapshot and log apart, the way an older build left it.
 */

import type { DocumentBackendHandlers } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { projectWorkspaceDocument, readSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { nodeText } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { Loro, LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedSyncDocument } from '../test-utils/seed-sync-document.js'
import { BrowserBackend } from './browser-backend.js'

const ISOLATED_DB = claimIsolatedWhiteboardDb('browser-backend-legacy-deltas')
const DOCUMENT_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
// Sized for IndexedDB reads under a loaded parallel run; the wait ends on the
// handler call, not on the clock.
const WAIT_TIMEOUT = 10_000

beforeEach(clearWhiteboardDb)
afterEach(clearWhiteboardDb)

function makeHandlers(): DocumentBackendHandlers {
  return {
    onSnapshot: vi.fn(),
    onRemoteUpdate: vi.fn(),
    onVersionCreated: vi.fn(),
    onRestoreStarted: vi.fn(),
    onRestoreComplete: vi.fn(),
    onViewportRequest: vi.fn(),
    onConnected: vi.fn(),
    onError: vi.fn(),
  }
}

it('places a legacy record with the edits its delta log holds', async () => {
  // No index row: the fold has nothing to adopt, so the backend's own
  // placement is what reads this record.
  const legacy = new Loro()
  legacy
    .getMap('nodes')
    .set('n1', textNode({ id: 'n1', x: 0, y: 0, width: 80, height: 40, text: 'snapshot' }))
  legacy.commit()
  const snapshot = legacy.export({ mode: 'snapshot' })
  const before = legacy.oplogVersion()
  legacy
    .getMap('nodes')
    .set('n2', textNode({ id: 'n2', x: 0, y: 80, width: 80, height: 40, text: 'from the log' }))
  legacy.commit()
  const delta = legacy.export({ mode: 'update', from: before })
  await seedSyncDocument(DOCUMENT_ID, { snapshot, deltas: [delta] }, ISOLATED_DB)

  const handlers = makeHandlers()
  const backend = new BrowserBackend({ documentId: DOCUMENT_ID, path: 'imported', kind: 'spatial' })
  backend.connect(handlers)
  await vi.waitFor(() => expect(handlers.onSnapshot).toHaveBeenCalledTimes(1), {
    timeout: WAIT_TIMEOUT,
  })
  backend.disconnect()

  const delivered = new LoroDoc()
  delivered.import(vi.mocked(handlers.onSnapshot).mock.calls[0][0])
  const projected = projectWorkspaceDocument(delivered, DOCUMENT_ID)
  if (projected === null) throw new Error('the delivered record holds no node for the document')
  expect(readSpatialCanvas(projected).nodes.map(nodeText).sort()).toEqual([
    'from the log',
    'snapshot',
  ])
})
