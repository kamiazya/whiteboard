/**
 * Two tabs of this origin holding one workspace record, as two backends in
 * one realm: BroadcastChannel delivers between distinct channel objects
 * whether they sit in two tabs or one, so the pair stands for two tabs.
 */
import type { DocumentBackendHandlers } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  documentContainers,
  readSpatialCanvas,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserBackend, type BrowserBackendTarget } from './browser-backend.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { announceVersion } from './workspace-broadcast.js'

claimIsolatedWhiteboardDb('browser-backend-cross-tab')

const DOC = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const WAIT = { timeout: 10_000 }

function target(documentId: string, path: string): BrowserBackendTarget {
  return { documentId, path, kind: 'spatial' }
}

function handlers(): DocumentBackendHandlers {
  return {
    onSnapshot: vi.fn(),
    onRemoteUpdate: vi.fn(),
    onVersionCreated: vi.fn(),
    onRestoreStarted: vi.fn(),
    onRestoreComplete: vi.fn(),
    onHeadChanged: vi.fn(),
    onViewportRequest: vi.fn(),
    onExportRequest: vi.fn(),
    onConnected: vi.fn(),
    onError: vi.fn(),
  }
}

async function open(
  t: BrowserBackendTarget,
): Promise<{ backend: BrowserBackend; h: DocumentBackendHandlers; doc: LoroDoc }> {
  const backend = new BrowserBackend(t)
  const h = handlers()
  backend.connect(h)
  await vi.waitFor(() => expect(h.onSnapshot).toHaveBeenCalledTimes(1), WAIT)
  const doc = new LoroDoc()
  doc.import(vi.mocked(h.onSnapshot).mock.calls[0][0])
  return { backend, h, doc }
}

const opened: BrowserBackend[] = []

beforeEach(async () => {
  await clearWhiteboardDb()
})
afterEach(async () => {
  for (const backend of opened.splice(0)) backend.disconnect()
  await clearWhiteboardDb()
})

it('an edit saved in one tab reaches the other as a remote update', async () => {
  const a = await open(target(DOC, 'design'))
  const b = await open(target(DOC, 'design'))
  opened.push(a.backend, b.backend)

  const from = a.doc.version()
  writeSpatialNode(
    documentContainers(a.doc, DOC),
    textNode({ id: 'n1', x: 0, y: 0, width: 80, height: 40, text: 'from tab A' }),
  )
  await a.backend.pushLocalUpdate(a.doc.export({ mode: 'update', from }))

  await vi.waitFor(() => expect(b.h.onRemoteUpdate).toHaveBeenCalled(), WAIT)
  for (const [bytes] of vi.mocked(b.h.onRemoteUpdate).mock.calls) b.doc.import(bytes)
  const seen = readSpatialCanvas(documentContainers(b.doc, DOC))
  expect(seen.nodes.map((n) => n.id)).toEqual(['n1'])
  // The tab that made the edit is not told about it again.
  expect(a.h.onRemoteUpdate).not.toHaveBeenCalled()
})

it('a version saved for a document reaches the tabs on it, and only those', async () => {
  const onDoc = await open(target(DOC, 'design'))
  const onOther = await open(target(OTHER, 'other'))
  opened.push(onDoc.backend, onOther.backend)

  const version = {
    id: '01CX5ZZKBKACTAV9WEVGEMMVRZ',
    path: 'design',
    createdAt: '2026-09-27T00:00:00.000Z',
    elementCount: 0,
    auto: false,
    branchName: 'main',
  }
  announceVersion(getBrowserWorkspaceId(), DOC, version)

  await vi.waitFor(() => expect(onDoc.h.onVersionCreated).toHaveBeenCalledWith(version), WAIT)
  expect(onOther.h.onVersionCreated).not.toHaveBeenCalled()
})
