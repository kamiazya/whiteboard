import { DuplicatingInMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import {
  type ContentClock,
  type DefaultDocumentPointer,
  listBrowserDocuments,
  loadBrowserDocument,
} from '../lib/browser-document-summary.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import type { LoroLoadResult } from '../lib/loro-store.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import type { LoroStoreLike } from '../pages/use-browser-document-controller.js'

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
 * Content bytes in a Map.
 *
 * Every create path now seeds a content record, so a jsdom test that leaves
 * `loro` to its default reaches real IndexedDB and the create throws. The
 * bytes are a placeholder rather than real Loro output — anything that runs
 * the actual merge needs `new Loro()` in the test itself.
 */
export class InMemoryLoroStore implements LoroStoreLike {
  saved: Array<{ id: string; bytes: Uint8Array }> = []
  shouldThrow = false
  #byId = new Map<string, Uint8Array>()

  async save(id: string, bytes: Uint8Array): Promise<void> {
    if (this.shouldThrow) throw new Error('loro save failed')
    this.saved.push({ id, bytes })
    this.#byId.set(id, bytes)
  }

  createEmptySnapshot(): Uint8Array {
    return new Uint8Array([1, 2, 3])
  }

  async load(id: string): Promise<LoroLoadResult> {
    const bytes = this.#byId.get(id)
    if (bytes === undefined) return { kind: 'not-found' }
    return { kind: 'ok', snapshot: bytes }
  }

  /**
   * The content half of the double's duplicate: the source's record, as
   * independent bytes, under the copy's id. A source with no record leaves
   * the copy with none, as it found it. Throws, and so leaves no copy, under
   * `shouldThrow` — a failed write is a duplicate that did not happen.
   */
  copyRecord(sourceId: string, copyId: string): void {
    if (this.shouldThrow) throw new Error('loro save failed')
    const bytes = this.#byId.get(sourceId)
    if (bytes === undefined) return
    const copy = bytes.slice()
    this.saved.push({ id: copyId, bytes: copy })
    this.#byId.set(copyId, copy)
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
  readonly loro = new InMemoryLoroStore()
  /**
   * Duplicates as the browser's own index does — one operation, placed by
   * the keepers' derivation — copying content within `loro` above. A page
   * handed a different Loro store reads none of the copy's content.
   */
  readonly index = new DuplicatingInMemoryDocumentIndex({
    copy: (from, to) => this.loro.copyRecord(from, to),
  })
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
      ...(snapshot.name === snapshot.path ? {} : { name: snapshot.name }),
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
   * `LoroStore.load`'s answer to give.
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
