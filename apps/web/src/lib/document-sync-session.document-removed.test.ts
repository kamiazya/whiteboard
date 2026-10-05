/**
 * The open document deleted somewhere else — an agent, another tab, another
 * member. The delete reaches the session as an ordinary update of the
 * workspace record, after which the document's node is simply not there:
 * every read of it throws, and every write lands on nothing. A session that
 * carried on would keep the editor live and report each later edit saved
 * while none of them is kept anywhere.
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
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPersistenceState } from './browser-persistence-state.js'
import {
  type BackendErrorReason,
  COMMIT_DEBOUNCE_MS,
  createDocumentSyncSession,
  createGenerationCounters,
} from './document-sync-session.js'
import type { EditorCommand } from './spatial/commands.js'

const DOC = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

const before = textNode({ id: 'kept', x: 0, y: 0, width: 100, height: 50, text: 'before' })

function workspaceRecord(): LoroDoc {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, { path: 'design', documentId: DOC, kind: 'spatial' })
  writeSpatialCanvas(documentContainers(record, DOC), { nodes: [before], edges: [] })
  return record
}

function added(canvas: SpatialCanvas, id: string): [SpatialCanvas, EditorCommand] {
  const node = textNode({ id, x: 0, y: 0, width: 100, height: 50, text: id })
  return [
    { ...canvas, nodes: [...canvas.nodes, node] },
    { kind: 'create-node', node },
  ]
}

function openSession() {
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
  const errors: (BackendErrorReason | null)[] = []
  const persistence: BrowserPersistenceState['kind'][] = []
  const session = createDocumentSyncSession(backend, {
    getOptions: () => ({}),
    onStatusChange: () => {},
    onBackendError: (reason) => errors.push(reason),
    onRestoreChange: () => {},
    onPersistenceChange: (state) => persistence.push(state.kind),
    dispatchIdentityEvent: () => {},
    generations: createGenerationCounters(),
    contentDocumentId: DOC,
  })
  session.connect()
  const peer = workspaceRecord()
  ;(handlers as unknown as DocumentBackendHandlers).onSnapshot(peer.export({ mode: 'snapshot' }))
  const deleteByPeer = () => {
    const from = peer.oplogVersion()
    deleteWorkspaceDocument(peer, { documentId: DOC })
    ;(handlers as unknown as DocumentBackendHandlers).onRemoteUpdate(
      peer.export({ mode: 'update', from }),
    )
  }
  // A restore from the trash re-mints the node under the documentId it had,
  // with the content the trash kept.
  const restoreByPeer = () => {
    const from = peer.oplogVersion()
    createWorkspaceDocumentAtPath(peer, { path: 'design', documentId: DOC, kind: 'spatial' })
    writeSpatialCanvas(documentContainers(peer, DOC), { nodes: [before], edges: [] })
    peer.commit()
    ;(handlers as unknown as DocumentBackendHandlers).onRemoteUpdate(
      peer.export({ mode: 'update', from }),
    )
  }
  return { session, errors, persistence, pushed, deleteByPeer, restoreByPeer }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a session whose deleted document is restored from the trash', () => {
  it('withdraws the removal it reported', () => {
    const s = openSession()
    s.deleteByPeer()

    s.restoreByPeer()

    expect(s.errors).toEqual(['document-removed', null])
    expect(s.session.getCanvas().nodes.map((node) => node.id)).toEqual(['kept'])
  })

  // An edit refused while the document was gone was never accepted, so it is
  // not replayed; the ones made after the restore are written and saved.
  it('writes and saves the edits made after the restore', async () => {
    const s = openSession()
    s.deleteByPeer()
    s.session.onChange(...added(s.session.getCanvas(), 'while-gone'))
    s.restoreByPeer()
    const pushesBefore = s.pushed.length

    s.session.onChange(...added(s.session.getCanvas(), 'after-restore'))
    await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS * 2)

    expect(s.session.getCanvas().nodes.map((node) => node.id)).toEqual(['kept', 'after-restore'])
    expect(s.pushed.length).toBeGreaterThan(pushesBefore)
    expect(s.persistence.at(-1)).toBe('saved')
  })
})

describe('a session whose document a peer deletes', () => {
  it('says the document was removed, once', () => {
    const s = openSession()

    s.deleteByPeer()

    expect(s.errors).toEqual(['document-removed'])
  })

  // The body signal is what a page re-reads the body, its facets and its
  // name on, so a delete must not hand a listener a read that throws.
  it('keeps every read a body listener makes total', () => {
    const s = openSession()
    const reads: string[] = []
    s.session.subscribeMarkdownBody(() => {
      try {
        s.session.getMarkdownBody()
        s.session.getCoreFacets()
        s.session.getFacets()
        s.session.getDocumentName()
        s.session.getNodeLocks()
        reads.push('ok')
      } catch (err) {
        reads.push(`threw: ${(err as Error).message}`)
      }
    })

    s.deleteByPeer()

    expect(reads.filter((read) => read !== 'ok')).toEqual([])
    expect(() => s.session.getMarkdownBody()).not.toThrow()
    expect(() => s.session.getEdgeLocks()).not.toThrow()
    expect(s.session.getCanvas().nodes.map((node) => node.id)).toEqual(['kept'])
  })

  it('takes no edit afterwards, and never reports one saved', async () => {
    const s = openSession()
    s.deleteByPeer()
    const pushesBefore = s.pushed.length

    s.session.onChange(...added(s.session.getCanvas(), 'after-delete'))
    await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS * 2)

    expect(s.session.getCanvas().nodes.map((node) => node.id)).toEqual(['kept'])
    expect(s.pushed).toHaveLength(pushesBefore)
    expect(s.persistence).not.toContain('saved')
  })

  // An edit still inside its debounce window when the delete arrives has
  // nowhere to land; the ledger must not settle it as saved.
  it('drops a write still in its window without calling it saved', async () => {
    const s = openSession()
    s.session.onChange(...added(s.session.getCanvas(), 'in-window'))

    s.deleteByPeer()
    await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS * 2)

    expect(s.persistence).toEqual(['pending'])
  })

  // A reconnect hands the session the record as it now stands, which no
  // longer holds the document; that is the same delete, not damaged bytes.
  it('keeps saying removed when a reconnect brings the record without it', () => {
    const s = openReconnecting()
    s.deleteByPeer({ tellSession: true })

    s.reconnect()

    expect(s.errors).toEqual(['document-removed'])
  })

  it('says removed when a reconnect is the first it hears of the delete', () => {
    const s = openReconnecting()
    s.deleteByPeer({ tellSession: false })

    s.reconnect()

    expect(s.errors).toEqual(['document-removed'])
  })
})

function openReconnecting() {
  let handlers: DocumentBackendHandlers | null = null
  const backend = {
    connect(h: DocumentBackendHandlers) {
      handlers = h
    },
    disconnect() {},
    pushLocalUpdate: () => Promise.resolve(),
    sendClientReady() {},
  } satisfies DocumentBackend
  const errors: (BackendErrorReason | null)[] = []
  const session = createDocumentSyncSession(backend, {
    getOptions: () => ({}),
    onStatusChange: () => {},
    onBackendError: (reason) => errors.push(reason),
    onRestoreChange: () => {},
    dispatchIdentityEvent: () => {},
    generations: createGenerationCounters(),
    contentDocumentId: DOC,
  })
  session.connect()
  const h = handlers as unknown as DocumentBackendHandlers
  const peer = workspaceRecord()
  h.onSnapshot(peer.export({ mode: 'snapshot' }))
  return {
    errors,
    deleteByPeer({ tellSession }: { tellSession: boolean }) {
      const from = peer.oplogVersion()
      deleteWorkspaceDocument(peer, { documentId: DOC })
      if (tellSession) h.onRemoteUpdate(peer.export({ mode: 'update', from }))
    },
    reconnect() {
      h.onSnapshot(peer.export({ mode: 'snapshot' }))
    },
  }
}
