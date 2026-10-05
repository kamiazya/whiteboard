/**
 * The name the workspace record holds for the session's document. A page's
 * title follows it, so a name written anywhere else — the keeper naming a
 * note after its heading, an agent's rename, another tab's — reaches the open
 * page as the record changes, with no request of its own.
 */
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  createWorkspaceDocumentAtPath,
  setWorkspaceDocumentName,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { createDocumentSyncSession, createGenerationCounters } from './document-sync-session.js'

const DOC = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function openSession(contentDocumentId?: string) {
  let handlers: DocumentBackendHandlers | null = null
  const backend = {
    connect(h: DocumentBackendHandlers) {
      handlers = h
      h.onConnected()
    },
    disconnect() {},
    pushLocalUpdate: () => Promise.resolve(),
    sendClientReady() {},
  } as unknown as DocumentBackend
  const session = createDocumentSyncSession(backend, {
    getOptions: () => ({}),
    onStatusChange: () => {},
    onBackendError: () => {},
    onRestoreChange: () => {},
    dispatchIdentityEvent: () => {},
    generations: createGenerationCounters(),
    ...(contentDocumentId === undefined ? {} : { contentDocumentId }),
  })
  session.connect()
  return { session, handlers: () => handlers as unknown as DocumentBackendHandlers }
}

function workspaceRecord(name?: string): LoroDoc {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, {
    path: 'untitled',
    documentId: DOC,
    kind: 'markdown',
    ...(name === undefined ? {} : { name }),
  })
  return record
}

describe('the session’s document name', () => {
  it('cannot say before the first snapshot', () => {
    const { session } = openSession(DOC)

    expect(session.getDocumentName()).toBeUndefined()
  })

  it('reads the name the record holds once it has hydrated', () => {
    const { session, handlers } = openSession(DOC)

    handlers().onSnapshot(workspaceRecord('Meeting').export({ mode: 'snapshot' }))

    expect(session.getDocumentName()).toBe('Meeting')
  })

  it('answers null for a document the record leaves unnamed', () => {
    const { session, handlers } = openSession(DOC)

    handlers().onSnapshot(workspaceRecord().export({ mode: 'snapshot' }))

    expect(session.getDocumentName()).toBeNull()
  })

  // A rename touches only the node's own map: no canvas value, no body. The
  // body signal is what a page re-reads its facets on, so it is the one that
  // has to carry this too.
  it('republishes on the body signal when a peer renames the document', () => {
    const { session, handlers } = openSession(DOC)
    const peer = workspaceRecord()
    handlers().onSnapshot(peer.export({ mode: 'snapshot' }))
    const heard = vi.fn(() => session.getDocumentName())
    const unsubscribe = session.subscribeMarkdownBody(heard)

    const from = peer.oplogVersion()
    setWorkspaceDocumentName(peer, { documentId: DOC, name: 'Weekly review' })
    handlers().onRemoteUpdate(peer.export({ mode: 'update', from }))

    expect(heard).toHaveReturnedWith('Weekly review')
    unsubscribe()
  })

  // A per-document backend's bytes ARE the document; there is no record, and
  // no name in them to follow.
  it('cannot say for a session with no workspace scope', () => {
    const { session, handlers } = openSession()
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, { nodes: [], edges: [] })
    handlers().onSnapshot(doc.export({ mode: 'snapshot' }))

    expect(session.getDocumentName()).toBeUndefined()
  })
})
