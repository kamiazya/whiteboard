/**
 * A removal belongs to the document it was raised for. When the page switches
 * to another backend — the next document opened in the same editor — the
 * reason the last one showed must not follow it, or that document opens
 * inert under a "removed elsewhere" notice it never earned.
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
import { expect, it } from 'vitest'
import { useDocumentSync } from './useDocumentSync.js'

const DOC = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function recordHoldingTheDocument(): LoroDoc {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, { path: 'design', documentId: DOC, kind: 'spatial' })
  writeSpatialCanvas(documentContainers(record, DOC), { nodes: [], edges: [] })
  record.commit()
  return record
}

function connectingBackend() {
  const box: { handlers: DocumentBackendHandlers | null } = { handlers: null }
  const backend = {
    connect(h: DocumentBackendHandlers) {
      box.handlers = h
      h.onConnected()
    },
    disconnect() {},
    pushLocalUpdate: () => Promise.resolve(),
    sendClientReady() {},
  } satisfies DocumentBackend
  const handlers = (): DocumentBackendHandlers => {
    if (box.handlers === null) throw new Error('the hook never connected this backend')
    return box.handlers
  }
  return { backend, handlers }
}

it('does not carry a removal across a switch to another backend', () => {
  const first = connectingBackend()
  const hook = renderHook(
    ({ backend }: { backend: DocumentBackend }) =>
      useDocumentSync(backend, { contentDocumentId: DOC }),
    { initialProps: { backend: first.backend } },
  )
  const peer = recordHoldingTheDocument()
  act(() => first.handlers().onSnapshot(peer.export({ mode: 'snapshot' })))
  const from = peer.oplogVersion()
  deleteWorkspaceDocument(peer, { documentId: DOC })
  act(() => first.handlers().onRemoteUpdate(peer.export({ mode: 'update', from })))
  expect(hook.result.current.backendError).toBe('document-removed')

  hook.rerender({ backend: connectingBackend().backend })

  expect(hook.result.current.backendError).toBeNull()
})
