/**
 * The dual-plane wiring the composition root injects into server-core, so
 * the agent tool surface and the daemon's own routes see ONE document.
 *
 * server-core addresses content as `document:` refs on the `DocumentStore`
 * port and placement through the `DocumentIndex` port. Content lives on the
 * workspace tree, so a tool surface left on the raw store would read and
 * write per-document rows the web app never sees. These wrappers route both
 * ports through the tree, which is also the only placement and listing
 * record: there is no documents table.
 */
import { isEngineTrap, openStandalone, type RecordSession } from '@kamiazya/whiteboard-loro-adapter'
import { bytesToBase64 } from '@kamiazya/whiteboard-model'
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
import { globalStoreScope, type StoreScope } from './store-scope.js'
import { evictWorkspaceDocCache, withStoredWorkspaceRecord } from './workspace-doc-cache.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

/**
 * Runs work on the workspace record and drops the cached record when the CRDT
 * engine traps inside it. A trap leaves the instance holding a lock it never
 * released, so every later call on it traps too; evicting is what lets the
 * next operation rebuild the record from storage instead of the daemon
 * serving a dead copy until it restarts. Only a trap evicts: any other failure
 * leaves the record sound.
 */
async function evictingOnEngineTrap<T>(
  workspaceId: string,
  scope: StoreScope,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (isEngineTrap(err)) evictWorkspaceDocCache(workspaceId, scope)
    throw err
  }
}

// The engine answers in the shapes the loro-adapter readers return; this
// module asserts the type and holds no schema of its own for it.
const asserted = <T>() => ({ parse: (value: unknown) => value as T })

/** What the record holds about a document: where it is placed and the digest of its content. */
interface PlacedDocument {
  readonly path: string
  readonly contentDigest: string
}

async function placeOf(record: RecordSession, documentId: string): Promise<PlacedDocument | null> {
  return record.read(
    { query: 'workspaceDocumentEntry', args: { documentId } },
    asserted<PlacedDocument | null>(),
  )
}

/**
 * Where a document stands, as the frontier a load answers and a save names as
 * `basedOn`: the digest of its content. Equal stamps mean the content did not
 * move, whatever the record's history did.
 */
const stampOf = (place: PlacedDocument): Uint8Array => new TextEncoder().encode(place.contentDigest)

const sameStamp = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index])

/**
 * The document's content with the tool's copy merged into it: what the record
 * holds now, opened as a document of its own, takes the copy's operations as
 * they are. Two writers who each inserted into text both started from keep
 * both inserts, and so does the shared text, twice: the copy and the record's
 * cut of the document each carry their own insert of it.
 */
async function mergedWith(
  record: RecordSession,
  documentId: string,
  copy: Uint8Array,
): Promise<Uint8Array | null> {
  const current = record.exportProjection(documentId)
  if (current === null) return null
  const { session, release } = await openStandalone(current)
  try {
    session.importJudged(copy, 'none')
    return session.exportSnapshot()
  } finally {
    release()
  }
}

/**
 * What a save of the tool's copy writes at the document's node: the copy as it
 * stands when the document is where the tool loaded it (the tool's edit IS the
 * change), and the copy merged into the document's present content when it
 * moved since — which is what keeps a canvas node another writer added. A save
 * naming no base has nothing to compare, and is the copy.
 */
async function contentToStore(
  record: RecordSession,
  place: PlacedDocument,
  documentId: string,
  copy: Uint8Array,
  basedOn: Uint8Array | undefined,
): Promise<Uint8Array | null> {
  if (basedOn === undefined || sameStamp(basedOn, stampOf(place))) return copy
  return mergedWith(record, documentId, copy)
}

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
    return withStoredWorkspaceRecord(docRef.workspaceId, this.scope, async (record) =>
      record === null ? null : placeOf(record, docRef.documentId),
    )
  }

  async loadSnapshot(input: LoadSnapshotInput): Promise<LoadSnapshotResult> {
    if (input.docRef.kind === 'document') {
      const { workspaceId, documentId } = input.docRef
      // A cut of the document as it stands, with the stamp of the state it was
      // cut at: the tool hands the stamp back on its save.
      const cut = await evictingOnEngineTrap(workspaceId, this.scope, () =>
        withStoredWorkspaceRecord(workspaceId, this.scope, async (record) => {
          if (record === null) return null
          const place = await placeOf(record, documentId)
          const bytes = place === null ? null : record.exportProjection(documentId)
          return place === null || bytes === null
            ? null
            : { bytes, frontier: stampOf(place) as Uint8Array<ArrayBuffer> }
        }),
      )
      if (cut !== null) {
        const { manifest, chunks } = chunkSnapshot(cut.bytes, DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES)
        return { manifest, chunks, frontier: cut.frontier }
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
        // Derived from the same cut loadSnapshot serves, so the two answers can
        // never disagree about whether a base exists.
        const loaded = await this.loadSnapshot({ docRef: input.docRef })
        // A cut has no stored row to fence, so it reports the generation a
        // never-folded record would: nothing can have replaced it. Compaction
        // folds the workspace record, never one document's cut.
        return loaded === null ? null : { manifest: loaded.manifest, generation: 0 }
      }
    }
    return this.inner.readSnapshotManifest(input)
  }

  async saveSnapshot(input: SaveSnapshotInput): Promise<void> {
    if (input.docRef.kind === 'document') {
      const { workspaceId, documentId } = input.docRef
      const wrote = await withWorkspaceWriteLock(workspaceId, () =>
        evictingOnEngineTrap(workspaceId, this.scope, () =>
          withStoredWorkspaceRecord(workspaceId, this.scope, async (record) => {
            if (record === null) return false
            const place = await placeOf(record, documentId)
            if (place === null) return false
            const source = await contentToStore(
              record,
              place,
              documentId,
              // Read only for a document the tree holds: the legacy plane takes
              // chunks as they come.
              reassembleSnapshot(input.manifest, input.chunks),
              input.basedOn,
            )
            if (source === null) return false
            record.write([
              {
                op: 'writeDocumentContentAndName',
                args: { documentId, source: bytesToBase64(source) },
              },
            ])
            await record.save()
            return true
          }),
        ),
      )
      if (wrote) return
    }
    return this.inner.saveSnapshot(input)
  }

  async saveCompactedSnapshot(
    input: SaveCompactedSnapshotInput,
  ): Promise<SaveCompactedSnapshotResult> {
    return this.inner.saveCompactedSnapshot(input)
  }

  async appendDeltas(input: AppendDeltasInput): Promise<AppendDeltasResult> {
    return this.inner.appendDeltas(input)
  }

  async loadDeltas(input: LoadDeltasInput): Promise<LoadDeltasResult> {
    return this.inner.loadDeltas(input)
  }

  // A tree-held document has no frontier of its own to answer: the content
  // digest its listing entry carries is what says whether it changed.
  async readFrontier(input: ReadFrontierInput): Promise<ReadFrontierResult> {
    return this.inner.readFrontier(input)
  }

  async deleteDoc(input: DeleteDocInput): Promise<void> {
    return this.inner.deleteDoc(input)
  }
}
