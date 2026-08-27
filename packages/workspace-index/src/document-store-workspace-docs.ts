/**
 * `WorkspaceDocs` over any `DocumentStore` — which is to say, over both
 * keepers.
 *
 * No new storage anywhere. `docRefKey({ kind: 'workspace-tree', workspaceId })`
 * keys into the same store every document already uses, and every
 * implementation passes the port's conformance for tree refs; the workspace
 * document is just another record, chunk-split and delta-logged like the rest.
 *
 * Written once because the browser version turned out to call nothing but
 * port methods — a second copy against libSQL would have differed in the
 * constructor argument and nothing else.
 */
import type { DocRef, DocumentStore } from '@kamiazya/whiteboard-ports'
import { chunkSnapshot, reassembleSnapshot, shouldCompact } from '@kamiazya/whiteboard-ports'
import { LoroDoc, VersionVector } from 'loro-crdt'
import type { WorkspaceDocs } from './workspace-docs.js'

const MAX_CHUNK_BYTES = 1_000_000

function refOf(workspaceId: string): DocRef {
  return { kind: 'workspace-tree', workspaceId }
}

export class DocumentStoreWorkspaceDocs implements WorkspaceDocs {
  constructor(private readonly store: DocumentStore) {}

  async open(workspaceId: string): Promise<LoroDoc | null> {
    const docRef = refOf(workspaceId)
    const stored = await this.store.loadSnapshot({ docRef })
    if (stored === null) return null
    const doc = new LoroDoc()
    doc.import(reassembleSnapshot(stored.manifest, stored.chunks))
    const { updates } = await this.store.loadDeltas({ docRef, sinceFrontier: new Uint8Array() })
    for (const update of updates) doc.import(update)
    return doc
  }

  async create(workspaceId: string): Promise<LoroDoc> {
    const existing = await this.open(workspaceId)
    if (existing !== null) return existing
    const doc = new LoroDoc()
    await this.save(workspaceId, doc)
    return doc
  }

  /**
   * The incremental shape both keepers converged on: append the delta since
   * the stored frontier, fold into a fresh snapshot once the log passes the
   * shared budget, and never write when nothing changed.
   *
   * Answers the update bytes it persisted — what a sync fan-out hands to the
   * workspace's other subscribers — and `null` when nothing was written.
   * Returned here rather than re-derived by the caller because only this
   * method knows the frontier the store held BEFORE the write; exporting
   * "since the stored frontier" afterwards yields an empty envelope.
   */
  async save(workspaceId: string, doc: LoroDoc): Promise<Uint8Array | null> {
    const docRef = refOf(workspaceId)
    const manifest = await this.store.readSnapshotManifest({ docRef })
    if (manifest === null) {
      const snapshot = doc.export({ mode: 'snapshot' })
      const { manifest: fresh, chunks } = chunkSnapshot(new Uint8Array(snapshot), MAX_CHUNK_BYTES)
      await this.store.saveSnapshot({
        docRef,
        manifest: fresh,
        chunks,
        frontier: new Uint8Array(doc.oplogVersion().encode()),
      })
      // The whole history as one update: what an empty peer needs.
      return new Uint8Array(doc.export({ mode: 'update' }))
    }

    const stored = await this.store.readFrontier({ docRef })
    if (stored === null) return null
    // A VERSION comparison, not a byte count: an update carrying no ops is
    // still 22 bytes of envelope, so an idle save would grow the log forever.
    const comparison = doc.oplogVersion().compare(VersionVector.decode(stored.frontier))
    if (comparison === 0) return null

    const update = new Uint8Array(
      doc.export({ mode: 'update', from: VersionVector.decode(stored.frontier) }),
    )
    const { updates: existing } = await this.store.loadDeltas({
      docRef,
      sinceFrontier: new Uint8Array(),
    })
    if (shouldCompact([...existing, update])) {
      const snapshot = doc.export({ mode: 'snapshot' })
      const { manifest: fresh, chunks } = chunkSnapshot(new Uint8Array(snapshot), MAX_CHUNK_BYTES)
      await this.store.saveCompactedSnapshot({
        docRef,
        manifest: fresh,
        chunks,
        frontier: new Uint8Array(doc.oplogVersion().encode()),
        supersededDeltaCount: existing.length,
      })
      return update
    }
    await this.store.appendDeltas({
      docRef,
      deltaBatch: {
        updates: [update],
        newFrontier: new Uint8Array(doc.oplogVersion().encode()),
      },
    })
    return update
  }
}
