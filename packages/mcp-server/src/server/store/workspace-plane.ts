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
 * (versions and the fold still key off it).
 */
import {
  isEngineTrap,
  resolveWorkspaceDocumentById,
  writeDocumentContentAndName,
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
import {
  chunkSnapshot,
  DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES,
  reassembleSnapshot,
} from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { evictDoc } from './doc-cache.js'
import { getDoc, openWorkspaceDocIfStored, saveWorkspaceDoc } from './document-store.js'
import { globalStoreScope, type StoreScope } from './store-scope.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

/**
 * Runs work on one document's cached projection and drops that projection when
 * the CRDT engine traps inside it. A trap leaves the instance holding a lock it
 * never released, so every later call on it traps too; evicting is what lets
 * the next operation rebuild the document from storage instead of the daemon
 * serving a dead copy until it restarts. Only a trap evicts: any other failure
 * leaves the projection sound.
 */
async function evictingOnEngineTrap<T>(
  workspaceId: string,
  path: string,
  scope: StoreScope,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (isEngineTrap(err)) evictDoc(workspaceId, path, scope)
    throw err
  }
}

/**
 * `DocumentStore` whose `document:` refs read and write THROUGH the
 * workspace tree when the tree holds the document, delegating everything
 * else — `workspace-tree` refs included — to the inner store. The tool
 * surface keeps its per-document mental model; only where the bytes live
 * changes.
 */
export class WorkspaceRoutedDocumentStore implements DocumentStore {
  /**
   * `scope` is the data directory whose live workspace documents this routes
   * through; `inner` is expected to be over the same one.
   */
  constructor(
    private readonly inner: DocumentStore,
    private readonly scope: StoreScope = globalStoreScope,
  ) {}

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
    const workspaceDoc = await openWorkspaceDocIfStored(docRef.workspaceId, this.scope)
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
        return evictingOnEngineTrap(input.docRef.workspaceId, entry.path, this.scope, async () => {
          const doc = await getDoc(input.docRef.workspaceId, entry.path, this.scope)
          const bytes = new Uint8Array(doc.export({ mode: 'snapshot' }))
          const { manifest, chunks } = chunkSnapshot(bytes, DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES)
          return {
            manifest,
            chunks,
            frontier: new Uint8Array(doc.oplogVersion().encode()),
          }
        })
      }
    }
    return this.inner.loadSnapshot(input)
  }

  async readSnapshotManifest(
    input: ReadSnapshotManifestInput,
  ): Promise<ReadSnapshotManifestResult> {
    if (input.docRef.kind === 'document') {
      const entry = await this.#treeEntry(input.docRef)
      if (entry !== null) {
        // Derived from the same projection loadSnapshot serves, so the two
        // answers can never disagree about whether a base exists.
        const loaded = await this.loadSnapshot({ docRef: input.docRef })
        // A projection has no stored row to fence, so it reports the generation
        // a never-folded record would: nothing can have replaced it. Compaction
        // of a tree-served document is refused below in any case.
        return loaded === null ? null : { manifest: loaded.manifest, generation: 0 }
      }
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
      // to acquire while the tool surface's document lock is held:
      // the lock is re-entrant per async chain and nothing nests the
      // two the other way around.
      const wrote = await withWorkspaceWriteLock(workspaceId, async () => {
        const workspaceDoc = await openWorkspaceDocIfStored(workspaceId, this.scope)
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
        return evictingOnEngineTrap(workspaceId, entry.path, this.scope, async () => {
          const live = await getDoc(workspaceId, entry.path, this.scope)
          live.import(doc.export({ mode: 'update' }))
          if (!writeDocumentContentAndName(workspaceDoc, documentId, live)) return false
          await saveWorkspaceDoc(workspaceId, workspaceDoc, this.scope)
          return true
        })
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
        return evictingOnEngineTrap(input.docRef.workspaceId, entry.path, this.scope, async () => {
          const doc = await getDoc(input.docRef.workspaceId, entry.path, this.scope)
          return { frontier: new Uint8Array(doc.oplogVersion().encode()) }
        })
      }
    }
    return this.inner.readFrontier(input)
  }

  async deleteDoc(input: DeleteDocInput): Promise<void> {
    return this.inner.deleteDoc(input)
  }
}
