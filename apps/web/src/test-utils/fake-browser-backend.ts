/**
 * Test double for `vi.mock('../lib/browser-backend.js')` sites.
 *
 * The real backend delivers the WORKSPACE document — one Loro doc whose tree
 * holds the target as a node — and the page scopes its sync session to that
 * node, so a mock that hands over a bare `new LoroDoc()` snapshot now fails
 * scope resolution and renders the unreadable-content view instead of the
 * editor. This double builds the same shape the real backend guarantees.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentBackendHandlers } from '@kamiazya/whiteboard-mcp/browser-contract'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import type { BrowserBackendTarget } from '../lib/browser-backend.js'

/** The workspace snapshot a real BrowserBackend would deliver for `target`. */
export function workspaceSnapshotFor(
  target: BrowserBackendTarget,
  canvas?: SpatialCanvas,
): Uint8Array {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, {
    path: target.path,
    documentId: target.documentId,
    kind: target.kind,
    ...(target.name === undefined ? {} : { name: target.name }),
  })
  if (canvas !== undefined) {
    writeSpatialCanvas(documentContainers(doc, target.documentId), canvas)
  }
  doc.commit()
  return doc.export({ mode: 'snapshot' })
}

/**
 * Connects synchronously, delivers a workspace snapshot holding its target
 * (with `initialCanvasFor`'s content when a subclass provides it), persists
 * nothing.
 */
export class FakeBrowserBackend {
  constructor(readonly target: BrowserBackendTarget) {}

  /** Override to seed the delivered document with content. */
  protected initialCanvasFor(_target: BrowserBackendTarget): SpatialCanvas | undefined {
    return undefined
  }

  connect(handlers: DocumentBackendHandlers): void {
    handlers.onConnected()
    handlers.onSnapshot(workspaceSnapshotFor(this.target, this.initialCanvasFor(this.target)))
  }

  disconnect(): void {}

  pushLocalUpdate(_bytes: Uint8Array): Promise<void> {
    return Promise.resolve()
  }

  getFile(_fileId: string): Promise<Blob | null> {
    return Promise.resolve(null)
  }

  putFile(newEntries: [string, unknown][], onFileSuccess: (fileId: string) => void): Promise<void> {
    for (const [fileId] of newEntries) onFileSuccess(fileId)
    return Promise.resolve()
  }

  sendClientReady(): void {}

  sendExportResponse(_requestId: string, _data: string): void {}
}
