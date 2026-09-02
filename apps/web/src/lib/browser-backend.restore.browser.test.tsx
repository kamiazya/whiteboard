import {
  projectWorkspaceDocument,
  readSpatialCanvas,
  writeSpatialCanvas,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentBackendHandlers } from '@kamiazya/whiteboard-mcp/browser-contract'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserBackend } from './browser-backend.js'

claimIsolatedWhiteboardDb('browserbackendrestore')

const DOC_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

/** One snapshot, no log — enough to stand in for the record here. */
class InMemoryWorkspaceDocs implements WorkspaceDocs {
  private stored: Uint8Array | null = null
  async open(): Promise<LoroDoc | null> {
    if (this.stored === null) return null
    const doc = new LoroDoc()
    doc.import(this.stored)
    return doc
  }
  async create(workspaceId: string): Promise<LoroDoc> {
    const existing = await this.open()
    if (existing !== null) return existing
    const doc = new LoroDoc()
    await this.save(workspaceId, doc)
    return doc
  }
  async save(_workspaceId: string, doc: LoroDoc): Promise<Uint8Array | null> {
    this.stored = new Uint8Array(doc.export({ mode: 'snapshot' }))
    return this.stored
  }
  async readCursor(): Promise<never> {
    throw new Error('not implemented')
  }
  async catchUp(): Promise<never> {
    throw new Error('not implemented')
  }
}

function textDoc(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text }],
    edges: [],
  })
  doc.commit()
  return doc
}

/**
 * A session's-eye view of the backend: the workspace doc it was handed,
 * kept in step through the same handlers the sync session installs.
 */
function connectSession(backend: BrowserBackend) {
  const session = new LoroDoc()
  const events: string[] = []
  let delivered = false
  const handlers: DocumentBackendHandlers = {
    onSnapshot: (bytes) => {
      session.import(bytes)
      delivered = true
    },
    onRemoteUpdate: (bytes) => {
      events.push('remote-update')
      session.import(bytes)
    },
    onVersionCreated: () => {},
    onRestoreStarted: (payload) => events.push(`restore-started:${payload.label ?? ''}`),
    onRestoreComplete: () => events.push('restore-complete'),
    onHeadChanged: () => {},
    onViewportRequest: () => {},
    onExportRequest: () => {},
    onConnected: () => {},
  }
  backend.connect(handlers)
  const ready = async () => {
    const started = Date.now()
    while (!delivered) {
      if (Date.now() - started > 5000) throw new Error('snapshot never delivered')
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  return { session, events, ready }
}

function textOf(doc: LoroDoc, documentId: string): string | undefined {
  // The session edits the WORKSPACE record; read this document's node back
  // out of it the way the page does, through its projection.
  const projected = projectWorkspaceDocument(doc, documentId)
  if (projected === null) throw new Error(`document ${documentId} is not in the record`)
  const node = readSpatialCanvas(projected).nodes[0]
  return node?.type === 'text' ? node.text : undefined
}

describe('BrowserBackend.applyRestore', () => {
  it('reconciles the record to the past state, persists it, and delivers the ops to the session as a remote update', async () => {
    const docs = new InMemoryWorkspaceDocs()
    const backend = new BrowserBackend(
      { documentId: DOC_ID, path: 'canvas-a', kind: 'spatial' },
      docs,
    )
    const { session, events, ready } = connectSession(backend)
    await ready()

    // The person types: the session's edit reaches the record through the
    // push path, exactly as the page does it.
    const before = session.version()
    writeWorkspaceDocumentContent(session, DOC_ID, textDoc('after the checkpoint'))
    await backend.pushLocalUpdate(session.export({ mode: 'update', from: before }))
    expect(textOf(session, DOC_ID)).toBe('after the checkpoint')

    await backend.applyRestore(textDoc('the checkpoint'), 'v1')

    // The session saw it as a peer's edit, bracketed like a daemon restore.
    expect(events).toEqual(['restore-started:v1', 'remote-update', 'restore-complete'])
    expect(textOf(session, DOC_ID)).toBe('the checkpoint')
    // And the record on disk agrees, so a reload lands on the restored state.
    const reopened = await docs.open()
    expect(reopened && textOf(reopened, DOC_ID)).toBe('the checkpoint')
  })

  it('completes the bracket even when persistence fails, and the failure reaches the caller', async () => {
    const docs = new InMemoryWorkspaceDocs()
    const backend = new BrowserBackend(
      { documentId: DOC_ID, path: 'canvas-a', kind: 'spatial' },
      docs,
    )
    const { events, ready } = connectSession(backend)
    await ready()
    docs.save = async () => {
      throw new Error('disk full')
    }

    await expect(backend.applyRestore(textDoc('the checkpoint'), 'v1')).rejects.toThrow('disk full')
    expect(events).toEqual(['restore-started:v1', 'restore-complete'])
  })
})
