/**
 * The dual-plane wiring the composition root injects into server-core, so
 * the agent tool surface and the daemon's own routes see ONE document.
 *
 * server-core addresses content as `document:` refs on the `DocumentStore`
 * port and placement through the `DocumentIndex` port. After the
 * workspace-document cutover, content lives on the workspace tree — so a
 * tool surface left on the raw store would read pre-fold copies and write
 * edits the web app never sees. These wrappers route both ports through the
 * tree while the `documents` table remains the placement/listing mirror
 * (versions, branches and the fold still key off it).
 */
import {
  resolveWorkspaceDocumentById,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import type {
  AppendDeltasInput,
  AppendDeltasResult,
  DeleteDocInput,
  DocumentStore,
  LoadDeltasInput,
  LoadDeltasResult,
  LoadSnapshotInput,
  LoadSnapshotResult,
  ReadFrontierInput,
  ReadFrontierResult,
  ReadSnapshotManifestInput,
  ReadSnapshotManifestResult,
  SaveCompactedSnapshotInput,
  SaveCompactedSnapshotResult,
  SaveSnapshotInput,
} from '@kamiazya/whiteboard-ports'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { getDoc, openWorkspaceDocIfStored, saveWorkspaceDoc } from './document-store.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

const SNAPSHOT_MAX_CHUNK_BYTES = 1_000_000

/**
 * `DocumentStore` whose `document:` refs read and write THROUGH the
 * workspace tree when the tree holds the document, delegating everything
 * else — `workspace-tree` refs included — to the inner store. The tool
 * surface keeps its per-document mental model; only where the bytes live
 * changes.
 */
export class WorkspaceRoutedDocumentStore implements DocumentStore {
  constructor(private readonly inner: DocumentStore) {}

  /**
   * The tree entry for a document ref, resolved through the ref's OWN
   * workspace (the ref carries it since W3) — no documents-table reverse
   * lookup. Null when the tree does not hold the document, which routes
   * the operation to the inner store (the legacy plane, or nothing).
   */
  async #treeEntry(docRef: {
    workspaceId: string
    documentId: string
  }): Promise<{ path: string } | null> {
    const workspaceDoc = await openWorkspaceDocIfStored(docRef.workspaceId)
    if (workspaceDoc === null) return null
    return resolveWorkspaceDocumentById(workspaceDoc, docRef.documentId)
  }

  async loadSnapshot(input: LoadSnapshotInput): Promise<LoadSnapshotResult> {
    if (input.docRef.kind === 'document') {
      const entry = await this.#treeEntry(input.docRef)
      if (entry !== null) {
        // Served from the SAME cached projection the route path mutates —
        // not a fresh per-call projection — so a tool's load-modify-save
        // round-trips through one lineage and its save is a real CRDT
        // merge (tombstones included) instead of a value diff against a
        // stranger's history.
        const doc = await getDoc(input.docRef.workspaceId, entry.path)
        const bytes = new Uint8Array(doc.export({ mode: 'snapshot' }))
        const { manifest, chunks } = chunkSnapshot(bytes, SNAPSHOT_MAX_CHUNK_BYTES)
        return {
          manifest,
          chunks,
          frontier: new Uint8Array(doc.oplogVersion().encode()),
        }
      }
    }
    return this.inner.loadSnapshot(input)
  }

  async readSnapshotManifest(
    input: ReadSnapshotManifestInput,
  ): Promise<ReadSnapshotManifestResult> {
    if (input.docRef.kind === 'document') {
      // Derived from the same projection loadSnapshot serves, so the two
      // answers can never disagree about whether a base exists.
      const loaded = await this.loadSnapshot({ docRef: input.docRef })
      // A projection has no stored row to fence, so it reports the generation
      // a never-folded record would: nothing can have replaced it. Compaction
      // of a tree-served document is refused below in any case.
      return loaded === null ? null : { manifest: loaded.manifest, generation: 0 }
    }
    return this.inner.readSnapshotManifest(input)
  }

  async saveSnapshot(input: SaveSnapshotInput): Promise<void> {
    if (input.docRef.kind === 'document') {
      const { workspaceId, documentId } = input.docRef
      // Under the workspace write lock, like every other writer of the
      // live workspace document — the route save path holds it too, so a
      // tool write and a route save on the same workspace settle into a
      // definite order instead of interleaving their diff-writes. Safe
      // to acquire while the tool surface's canvas-doc lock is held:
      // the lock is re-entrant per async chain and nothing nests the
      // two the other way around anymore.
      const wrote = await withWorkspaceWriteLock(workspaceId, async () => {
        const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
        if (workspaceDoc === null) return false
        const entry = resolveWorkspaceDocumentById(workspaceDoc, documentId)
        // A document the tree does not hold has no path here — the create
        // path (documentIndex.createDocument) is what places one, so a
        // save for an unknown id falls through to the inner store rather
        // than inventing a placement.
        if (entry === null) return false
        const doc = new LoroDoc()
        doc.import(reassembleSnapshot(input.manifest, input.chunks))
        // MERGE into the cached projection — the doc instance
        // loadSnapshot serves and every route save mutates — rather
        // than diff-writing the tool's own copy over the tree. A tool
        // that loaded before a concurrent route write then converges
        // with it (import is a CRDT merge; ops the projection already
        // has are no-ops) instead of value-diffing the other writer's
        // edit back out.
        const live = await getDoc(workspaceId, entry.path)
        live.import(doc.export({ mode: 'update' }))
        if (!writeWorkspaceDocumentContent(workspaceDoc, documentId, live)) return false
        await saveWorkspaceDoc(workspaceId, workspaceDoc)
        return true
      })
      if (wrote) return
    }
    return this.inner.saveSnapshot(input)
  }

  async saveCompactedSnapshot(
    input: SaveCompactedSnapshotInput,
  ): Promise<SaveCompactedSnapshotResult> {
    // Compaction is a legacy-plane concern: a tree-served document has no
    // per-document log to fold. Delegated as-is.
    return this.inner.saveCompactedSnapshot(input)
  }

  async appendDeltas(input: AppendDeltasInput): Promise<AppendDeltasResult> {
    return this.inner.appendDeltas(input)
  }

  async loadDeltas(input: LoadDeltasInput): Promise<LoadDeltasResult> {
    return this.inner.loadDeltas(input)
  }

  async readFrontier(input: ReadFrontierInput): Promise<ReadFrontierResult> {
    if (input.docRef.kind === 'document') {
      const entry = await this.#treeEntry(input.docRef)
      if (entry !== null) {
        // The projection's version, same source as loadSnapshot's
        // `frontier` — this is what ContentFactsCache stamps search /
        // backlinks / tags facts with, and the retired per-document
        // record would answer null here, silently blanking the whole
        // corpus. The stamp is per-process (a re-projection mints a new
        // lineage), which can only over-invalidate, never under.
        const doc = await getDoc(input.docRef.workspaceId, entry.path)
        return { frontier: new Uint8Array(doc.oplogVersion().encode()) }
      }
    }
    return this.inner.readFrontier(input)
  }

  async deleteDoc(input: DeleteDocInput): Promise<void> {
    return this.inner.deleteDoc(input)
  }
}
