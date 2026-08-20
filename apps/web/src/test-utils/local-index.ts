import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import {
  type ContentClock,
  InMemoryDefaultDocumentPointer,
  LOCAL_WORKSPACE_ID,
  listLocalDocuments,
  loadLocalDocument,
} from '../lib/local-document-summary.js'
import type { LoroLoadResult } from '../lib/loro-store.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import type { LoroStoreLike } from '../pages/use-browser-local-document-controller.js'

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
}

export interface SeededLocal {
  index: InMemoryDocumentIndex
  pointer: InMemoryDefaultDocumentPointer
  clock: ContentClock
}

/**
 * A browser-local backing store for a page test, seeded from the same
 * `DocumentSnapshot` fixtures the bespoke store used to take.
 *
 * Three pieces rather than one, because that is what the production wiring is
 * now: the port's index for placement and identity, and two app-side concerns
 * it deliberately does not own — which document a plain load resumes into, and
 * when a document was last edited.
 *
 * `seed` rather than `createDocument`, so a fixture keeps the id it declares.
 * The port refuses a caller-chosen id on the real path on purpose — assigning
 * it is the index's job — and its test double carries this escape hatch for
 * exactly this: a test that asserts on an id it wrote.
 *
 * The clock is a plain map, so a jsdom test gets its fixtures' timestamps
 * without an IndexedDB anywhere near it.
 */
export function seedLocal(
  snapshots: readonly DocumentSnapshot[] = [],
  defaultDocumentId?: string,
): SeededLocal {
  const index = new InMemoryDocumentIndex()
  // Registered up front. `seed` adds the workspace as a side effect, so a
  // double that is seeded works by accident — but `seedLocal([])` and a
  // `LocalStoreDouble` read before its first `save` would answer
  // `WorkspaceNotFoundError` where production answers an empty list, which is
  // the one case a test of the empty state most wants to reach.
  void index.createWorkspace({ workspaceId: LOCAL_WORKSPACE_ID })
  const stamps = new Map<string, string>()
  for (const snapshot of snapshots) {
    index.seed({
      workspaceId: LOCAL_WORKSPACE_ID,
      documentId: snapshot.documentId,
      path: snapshot.path,
      kind: snapshot.kind,
      // Absent rather than the path, matching what the index stores: a
      // document whose name equals its path has no name of its own, and the
      // listing's fallback is what puts one back.
      ...(snapshot.name === snapshot.path ? {} : { name: snapshot.name }),
    })
    stamps.set(snapshot.documentId, snapshot.updatedAt)
  }
  const pointer = new InMemoryDefaultDocumentPointer()
  if (defaultDocumentId !== undefined) void pointer.set(defaultDocumentId)
  const clock: ContentClock = async (ids) =>
    new Map(ids.flatMap((id) => (stamps.has(id) ? [[id, stamps.get(id) as string]] : [])))
  return { index, pointer, clock }
}

/**
 * The same three pieces, behind the write methods the bespoke store used to
 * offer, so a test that seeds imperatively keeps its shape.
 *
 * This is a TEST DOUBLE, not a shim on the way back: production has no such
 * object, and the methods here exist only because a fixture reads better as
 * `await store.save(snap)` than as a list assembled before the object it
 * seeds. `save` is an upsert because fixtures use it as one; the production
 * path it replaced was five creates and one rename, which is why the port
 * needed no upsert of its own.
 */
export class LocalStoreDouble {
  readonly index = new InMemoryDocumentIndex()

  readonly pointer = new InMemoryDefaultDocumentPointer()
  readonly loro = new InMemoryLoroStore()
  readonly #stamps = new Map<string, string>()

  readonly clock: ContentClock = async (ids) =>
    new Map(
      ids.flatMap((id) => (this.#stamps.has(id) ? [[id, this.#stamps.get(id) as string]] : [])),
    )

  constructor() {
    // See `seedLocal` above: an unseeded double must still LIST, not throw.
    // The in-memory index registers the workspace synchronously, so the
    // promise is complete before any caller can observe it.
    void this.index.createWorkspace({ workspaceId: LOCAL_WORKSPACE_ID })
  }

  async save(snapshot: DocumentSnapshot): Promise<void> {
    this.index.seed({
      workspaceId: LOCAL_WORKSPACE_ID,
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
    return listLocalDocuments(this.index, this.clock)
  }

  /**
   * Reads a fixture back. Two outcomes, not the bespoke store's three: the
   * index holds the document or it does not, and whether its CONTENT reads is
   * `LoroStore.load`'s answer to give.
   */
  async load(documentId: string): Promise<DocumentSnapshot | null> {
    return loadLocalDocument(this.index, documentId, this.clock)
  }

  async removeDocument(documentId: string): Promise<void> {
    const entry = await this.index.resolveDocumentById({
      workspaceId: LOCAL_WORKSPACE_ID,
      documentId,
    })
    if (entry === null) return
    await this.index.deleteDocument({ workspaceId: LOCAL_WORKSPACE_ID, path: entry.path })
  }
}
