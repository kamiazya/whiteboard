/**
 * The reason a page shows for its document, across a delete elsewhere and a
 * restore from the trash. The session raises `document-removed` itself and
 * withdraws it with `null`; a failure the backend reported is a different
 * fact, and the withdrawal must not take it along.
 */
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceDocument,
  documentContainers,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { act, renderHook } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { useDocumentSync } from './useDocumentSync.js'

const DOC = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function addDocument(record: LoroDoc): void {
  createWorkspaceDocumentAtPath(record, { path: 'design', documentId: DOC, kind: 'spatial' })
  writeSpatialCanvas(documentContainers(record, DOC), { nodes: [], edges: [] })
  record.commit()
}

function openDocument() {
  let handlers: DocumentBackendHandlers | null = null
  const backend = {
    connect(h: DocumentBackendHandlers) {
      handlers = h
      h.onConnected()
    },
    disconnect() {},
    pushLocalUpdate: () => Promise.resolve(),
    sendClientReady() {},
  } satisfies DocumentBackend
  const hook = renderHook(() => useDocumentSync(backend, { contentDocumentId: DOC }))
  const h = () => handlers as unknown as DocumentBackendHandlers
  const peer = new LoroDoc()
  addDocument(peer)
  act(() => h().onSnapshot(peer.export({ mode: 'snapshot' })))
  // Each peer change reaches the session the way a keeper relays one.
  const change = (edit: () => void) => {
    const from = peer.oplogVersion()
    edit()
    act(() => h().onRemoteUpdate(peer.export({ mode: 'update', from })))
  }
  return {
    hook,
    fail: (reason: Parameters<NonNullable<DocumentBackendHandlers['onError']>>[0]) =>
      act(() => h().onError?.(reason)),
    deleteByPeer: () => change(() => deleteWorkspaceDocument(peer, { documentId: DOC })),
    restoreByPeer: () => change(() => addDocument(peer)),
  }
}

describe('the backend error a page reads across a delete and a restore', () => {
  it('shows the removal while it lasts and nothing once the document is back', () => {
    const page = openDocument()

    page.deleteByPeer()
    expect(page.hook.result.current.backendError).toBe('document-removed')

    page.restoreByPeer()
    expect(page.hook.result.current.backendError).toBeNull()
  })

  it('keeps a storage failure raised before the removal once it is withdrawn', () => {
    const page = openDocument()
    page.fail('storage-failure')

    page.deleteByPeer()
    expect(page.hook.result.current.backendError).toBe('document-removed')

    page.restoreByPeer()
    expect(page.hook.result.current.backendError).toBe('storage-failure')
  })

  it('keeps showing the removal over a failure raised during it', () => {
    const page = openDocument()
    page.deleteByPeer()

    page.fail('storage-failure')
    expect(page.hook.result.current.backendError).toBe('document-removed')

    page.restoreByPeer()
    expect(page.hook.result.current.backendError).toBe('storage-failure')
  })
})
