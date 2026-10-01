/**
 * Two tabs of this origin holding one workspace record, as two backends in
 * one realm: BroadcastChannel delivers between distinct channel objects
 * whether they sit in two tabs or one, so the pair stands for two tabs.
 */
import type { DocumentBackendHandlers } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  documentContainers,
  readMarkdownBody,
  readSpatialCanvas,
  writeMarkdownBody,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { expectLoggedFailures } from '../test-utils/browser-setup.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserBackend, type BrowserBackendTarget } from './browser-backend.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { announceVersion, listenToWorkspace } from './workspace-broadcast.js'

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

it("another tab's edit applies to a note the first tab named from its heading", async () => {
  // Unnamed, so the first save names it after the heading — ops the backend
  // makes on its own copy of the record, which the other tab's edit then
  // builds on. A session that never received them holds that edit pending.
  const a = await open({ documentId: DOC, path: 'untitled', kind: 'markdown' })
  opened.push(a.backend)
  const from = a.doc.version()
  writeMarkdownBody(documentContainers(a.doc, DOC), '# Named from the heading\n')
  await a.backend.pushLocalUpdate(a.doc.export({ mode: 'update', from }))

  const b = await open({ documentId: DOC, path: 'untitled', kind: 'markdown' })
  opened.push(b.backend)
  const fromB = b.doc.version()
  writeMarkdownBody(documentContainers(b.doc, DOC), '# Named from the heading\n\nfrom tab B\n')
  await b.backend.pushLocalUpdate(b.doc.export({ mode: 'update', from: fromB }))

  await vi.waitFor(() => {
    for (const [bytes] of vi.mocked(a.h.onRemoteUpdate).mock.calls) a.doc.import(bytes)
    expect(readMarkdownBody(documentContainers(a.doc, DOC))).toContain('from tab B')
  }, WAIT)
})

it('bytes this record cannot import are skipped, and the tab keeps saving', async () => {
  const logged = expectLoggedFailures()
  const a = await open(target(DOC, 'design'))
  opened.push(a.backend)
  const garbage = new Uint8Array([1, 2, 3, 4])
  expect(() => new LoroDoc().import(garbage)).toThrow()
  const marker = new LoroDoc()
  marker.getMap('marker').set('seen', true)
  const valid = marker.export({ mode: 'update' })

  const sender = listenToWorkspace(getBrowserWorkspaceId(), () => {})
  sender.post({ type: 'update', bytes: garbage })
  sender.post({ type: 'update', bytes: valid })
  // The one after the bad one still lands: the queue did not stay rejected.
  await vi.waitFor(() => expect(a.h.onRemoteUpdate).toHaveBeenCalledWith(valid), WAIT)
  sender.close()
  expect(a.h.onRemoteUpdate).not.toHaveBeenCalledWith(garbage)

  const from = a.doc.version()
  writeSpatialNode(
    documentContainers(a.doc, DOC),
    textNode({ id: 'n2', x: 0, y: 0, width: 80, height: 40, text: 'still saving' }),
  )
  await expect(a.backend.pushLocalUpdate(a.doc.export({ mode: 'update', from }))).resolves.toBe(
    undefined,
  )
  expect(logged.join('\n')).toContain('[browser-backend] skipped an update from another tab')
})

it('a save landing between reading the record and listening still reaches the tab', async () => {
  const b = await open(target(DOC, 'design'))
  opened.push(b.backend)

  // Holds A just AFTER its read of the record: the window where a save is in
  // neither the bytes A read nor, when listening began only at delivery, any
  // message A hears.
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let read = false
  class HeldAfterRead extends BrowserWorkspaceDocs {
    override async create(workspaceId: string): Promise<LoroDoc> {
      const doc = await super.create(workspaceId)
      read = true
      await gate
      return doc
    }
  }
  const a = new BrowserBackend(target(DOC, 'design'), new HeldAfterRead())
  opened.push(a)
  const ha = handlers()
  a.connect(ha)
  await vi.waitFor(() => expect(read).toBe(true), WAIT)

  const heard: unknown[] = []
  const probe = listenToWorkspace(getBrowserWorkspaceId(), (message) => heard.push(message))
  const from = b.doc.version()
  writeSpatialNode(
    documentContainers(b.doc, DOC),
    textNode({ id: 'n3', x: 0, y: 0, width: 80, height: 40, text: 'saved meanwhile' }),
  )
  await b.backend.pushLocalUpdate(b.doc.export({ mode: 'update', from }))
  await vi.waitFor(() => expect(heard).toHaveLength(1), WAIT)
  probe.close()
  release()

  await vi.waitFor(() => expect(ha.onSnapshot).toHaveBeenCalledTimes(1), WAIT)
  const twin = new LoroDoc()
  twin.import(vi.mocked(ha.onSnapshot).mock.calls[0][0])
  for (const [bytes] of vi.mocked(ha.onRemoteUpdate).mock.calls) twin.import(bytes)
  expect(readSpatialCanvas(documentContainers(twin, DOC)).nodes.map((n) => n.id)).toContain('n3')
})
