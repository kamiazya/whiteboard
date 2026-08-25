/**
 * `WorkspaceDocs` for the browser: where a workspace's Loro document comes
 * from, and where a change to it goes.
 *
 * No new object store. `docRefKey({ kind: 'workspace-tree', workspaceId })`
 * keys into the same `syncDocuments` store every document already uses, and
 * `IdbDocumentStore` passes the port's conformance for tree refs — so the
 * workspace document is just another record, chunk-split and delta-logged
 * like the rest. The v13 layout split was the prerequisite: appending one
 * edit to the workspace document must not deserialize the whole workspace.
 */
import type { DocRef } from '@kamiazya/whiteboard-ports'
import { chunkSnapshot, reassembleSnapshot, shouldCompact } from '@kamiazya/whiteboard-ports'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { Loro, type LoroDoc, VersionVector } from 'loro-crdt'
import { IdbDocumentStore } from './idb-document-store.js'

const MAX_CHUNK_BYTES = 1_000_000

function refOf(workspaceId: string): DocRef {
  return { kind: 'workspace-tree', workspaceId }
}

export class BrowserWorkspaceDocs implements WorkspaceDocs {
  readonly #store: IdbDocumentStore

  /** Only tests pass this; see `openWhiteboardDb`'s note on why it exists. */
  constructor(dbName?: string) {
    this.#store = new IdbDocumentStore(dbName)
  }

  async open(workspaceId: string): Promise<LoroDoc | null> {
    const docRef = refOf(workspaceId)
    const stored = await this.#store.loadSnapshot({ docRef })
    if (stored === null) return null
    const doc = new Loro()
    doc.import(reassembleSnapshot(stored.manifest, stored.chunks))
    const { updates } = await this.#store.loadDeltas({ docRef, sinceFrontier: new Uint8Array() })
    for (const update of updates) doc.import(update)
    return doc
  }

  async create(workspaceId: string): Promise<LoroDoc> {
    const existing = await this.open(workspaceId)
    if (existing !== null) return existing
    const doc = new Loro()
    await this.save(workspaceId, doc)
    return doc
  }

  /**
   * The daemon's incremental shape, one keeper over: append the delta since
   * the stored frontier, fold into a fresh snapshot once the log passes the
   * budget, and never write when nothing changed.
   */
  async save(workspaceId: string, doc: LoroDoc): Promise<void> {
    const docRef = refOf(workspaceId)
    const manifest = await this.#store.readSnapshotManifest({ docRef })
    if (manifest === null) {
      const snapshot = doc.export({ mode: 'snapshot' })
      const { manifest: fresh, chunks } = chunkSnapshot(new Uint8Array(snapshot), MAX_CHUNK_BYTES)
      await this.#store.saveSnapshot({
        docRef,
        manifest: fresh,
        chunks,
        frontier: new Uint8Array(doc.oplogVersion().encode()),
      })
      return
    }

    const stored = await this.#store.readFrontier({ docRef })
    if (stored === null) return
    // A VERSION comparison, not a byte count: an update carrying no ops is
    // still 22 bytes of envelope, so an idle save would grow the log forever.
    const comparison = doc.oplogVersion().compare(VersionVector.decode(stored.frontier))
    if (comparison === 0) return

    const update = doc.export({ mode: 'update', from: VersionVector.decode(stored.frontier) })
    const { updates: existing } = await this.#store.loadDeltas({
      docRef,
      sinceFrontier: new Uint8Array(),
    })
    if (shouldCompact([...existing, update])) {
      const snapshot = doc.export({ mode: 'snapshot' })
      const { manifest: fresh, chunks } = chunkSnapshot(new Uint8Array(snapshot), MAX_CHUNK_BYTES)
      await this.#store.saveCompactedSnapshot({
        docRef,
        manifest: fresh,
        chunks,
        frontier: new Uint8Array(doc.oplogVersion().encode()),
        supersededDeltaCount: existing.length,
      })
      return
    }
    await this.#store.appendDeltas({
      docRef,
      deltaBatch: {
        updates: [new Uint8Array(update)],
        newFrontier: new Uint8Array(doc.oplogVersion().encode()),
      },
    })
  }
}
