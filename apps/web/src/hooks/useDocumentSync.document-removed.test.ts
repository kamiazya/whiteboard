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
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, renderHook } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMMIT_DEBOUNCE_MS } from '../lib/document-sync-session.js'
import { useDocumentSync } from './useDocumentSync.js'

const DOC = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function addDocument(record: LoroDoc): void {
  createWorkspaceDocumentAtPath(record, { path: 'design', documentId: DOC, kind: 'spatial' })
  writeSpatialCanvas(documentContainers(record, DOC), { nodes: [], edges: [] })
  record.commit()
}

function openDocument() {
  let handlers: DocumentBackendHandlers | null = null
  const pushed: Uint8Array[] = []
  const backend = {
    connect(h: DocumentBackendHandlers) {
      handlers = h
      h.onConnected()
    },
    disconnect() {},
    pushLocalUpdate: (bytes: Uint8Array) => {
      pushed.push(bytes)
      return Promise.resolve()
    },
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
    pushed,
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

describe('the undo shortcut on a page whose document a peer deleted', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // The keydown listener is on the window, so the inert editor under the
  // removal notice does not keep the shortcut from reaching the session.
  it('writes nothing and leaves the key to the browser', async () => {
    vi.useFakeTimers()
    const page = openDocument()
    const node = textNode({ id: 'mine', x: 0, y: 0, width: 100, height: 50, text: 'mine' })
    const next: SpatialCanvas = { nodes: [node], edges: [] }
    act(() => page.hook.result.current.onChange(next, { kind: 'create-node', node }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS * 2)
    })
    expect(page.hook.result.current.canUndo()).toBe(true)
    page.deleteByPeer()
    const pushesBefore = page.pushed.length

    const event = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => {
      window.dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(false)
    expect(page.pushed).toHaveLength(pushesBefore)
    expect(page.hook.result.current.canvas.nodes.map((n) => n.id)).toEqual(['mine'])
  })
})
