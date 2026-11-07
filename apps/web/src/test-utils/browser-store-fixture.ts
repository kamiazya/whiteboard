import { DuplicatingInMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import {
  type ContentClock,
  type DefaultDocumentPointer,
  listBrowserDocuments,
  loadBrowserDocument,
} from '../lib/browser-document-summary.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'

/** The pointer a test gets when it is testing a page, not persistence. */
class InMemoryDefaultDocumentPointer implements DefaultDocumentPointer {
  private documentId: string | null = null

  get(): Promise<string | null> {
    return Promise.resolve(this.documentId)
  }

  set(documentId: string): Promise<void> {
    this.documentId = documentId
    return Promise.resolve()
  }

  clear(): Promise<void> {
    this.documentId = null
    return Promise.resolve()
  }
}

/**
 * The same three pieces, behind imperative write methods, so a test that seeds imperatively keeps its shape.
 *
 * This is a TEST DOUBLE, not a shim on the way back: production has no such
 * object, and the methods here exist only because a fixture reads better as
 * `await store.save(snap)` than as a list assembled before the object it
 * seeds. `save` is an upsert because fixtures use it as one; the production
 * path it replaced was five creates and one rename, which is why the port
 * needed no upsert of its own.
 */
export class BrowserStoreDouble {
  readonly pointer = new InMemoryDefaultDocumentPointer()
  /**
   * Duplicates as the browser's own index does — one operation, placed by
   * the keepers' derivation. Placement only: the copy's content lives in the
   * workspace tree, which this double does not hold.
   */
  readonly index = new DuplicatingInMemoryDocumentIndex({ copy: () => {} })
  readonly #stamps = new Map<string, string>()

  readonly clock: ContentClock = async (ids) =>
    new Map(
      ids.flatMap((id) => (this.#stamps.has(id) ? [[id, this.#stamps.get(id) as string]] : [])),
    )

  constructor() {
    // An unseeded double must still LIST, not throw.
    // The in-memory index registers the workspace synchronously, so the
    // promise is complete before any caller can observe it.
    void this.index.createWorkspace({ workspaceId: getBrowserWorkspaceId() })
  }

  async save(snapshot: DocumentSnapshot): Promise<void> {
    this.index.seed({
      workspaceId: getBrowserWorkspaceId(),
      documentId: snapshot.documentId,
      path: snapshot.path,
      kind: snapshot.kind,
      ...(snapshot.name === null ? {} : { name: snapshot.name }),
    })
    this.#stamps.set(snapshot.documentId, snapshot.updatedAt)
  }

  async setDefaultDocumentId(documentId: string): Promise<void> {
    await this.pointer.set(documentId)
  }

  async getDefaultDocumentId(): Promise<string | null> {
    return this.pointer.get()
  }

  async listDocuments(): Promise<DocumentSnapshot[]> {
    return listBrowserDocuments(this.index, this.clock)
  }

  /**
   * Reads a fixture back. Two outcomes, not the bespoke store's three: the
   * index holds the document or it does not, and whether its CONTENT reads is
   * the backend's answer to give.
   */
  async load(documentId: string): Promise<DocumentSnapshot | null> {
    return loadBrowserDocument(this.index, documentId, this.clock)
  }

  async removeDocument(documentId: string): Promise<void> {
    const entry = await this.index.resolveDocumentById({
      workspaceId: getBrowserWorkspaceId(),
      documentId,
    })
    if (entry === null) return
    await this.index.deleteDocument({ workspaceId: getBrowserWorkspaceId(), path: entry.path })
  }
}
