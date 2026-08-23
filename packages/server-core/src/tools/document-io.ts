import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentId, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import type { ServerDeps } from '../server-deps.js'

/**
 * A single chunk always fits Loro's snapshot output for the geometry/text
 * mutations these patch tools perform; this cap only matters once a
 * store/sync implementation enforces its own message-size limit, which is
 * out of this shared layer's scope.
 */
const SNAPSHOT_MAX_CHUNK_BYTES = 1_000_000

/**
 * Thrown when a document has no saved snapshot. Not a Zod schema — only
 * `.message` crosses the MCP wire via the SDK's existing tool-error path, so
 * this is a plain Error subclass rather than a DTO.
 *
 * It lives beside the loader that raises it, and it is the ONLY class for
 * this condition: read-side and write-side callers alike go through
 * `loadDocument`, so `create-server.ts` maps one class to its 404 rather
 * than a list that a new loader could silently grow.
 *
 * Distinct from `WorkspaceDocumentNotFoundError` (the workspace INDEX has no
 * such document) and from ports' own `DocumentNotFoundError` (an operation
 * named a document the index does not hold) — different conditions, and
 * naming this one for the snapshot keeps all three tellable apart.
 */
export class SnapshotNotFoundError extends Error {
  constructor(readonly documentId: string) {
    super(`document has no saved snapshot: ${documentId}`)
    this.name = 'SnapshotNotFoundError'
  }
}

export interface LoadedDocument {
  doc: LoroDoc
  canvas: SpatialCanvas
}

/**
 * Loads a canvas doc for patching. Unlike `wb_facet_set` (which tolerates a
 * missing doc — facets can be set on a brand-new canvas), a patch targets
 * an *existing* element by id, so there is nothing sensible to patch in a
 * doc that has never been saved. This deliberately throws instead of
 * falling back to an empty `LoroDoc`.
 */
export async function loadDocument(
  deps: ServerDeps,
  documentId: DocumentId,
): Promise<LoadedDocument> {
  const docRef = { kind: 'document' as const, documentId }
  const existing = await deps.documentStore.loadSnapshot({ docRef })
  if (existing === null) throw new SnapshotNotFoundError(documentId)

  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(existing.manifest, existing.chunks))
  return { doc, canvas: readSpatialCanvas(doc) }
}

/**
 * Loads an existing canvas doc or creates a fresh one when no snapshot
 * exists yet. Used by `wb_facet_set` where setting facets on a never-saved
 * canvas is valid (unlike spatial patch tools, which require an existing
 * element to target).
 */
export async function loadOrCreateDocument(
  deps: ServerDeps,
  documentId: DocumentId,
): Promise<LoroDoc> {
  const docRef = { kind: 'document' as const, documentId }
  const existing = await deps.documentStore.loadSnapshot({ docRef })
  const doc = new LoroDoc()
  if (existing !== null) {
    doc.import(reassembleSnapshot(existing.manifest, existing.chunks))
  }
  return doc
}

/**
 * Exports the LoroDoc as a chunked snapshot and persists it. Shared by
 * `saveDocumentBodySnapshot` (spatial patch tools) and `wb_facet_set` (facet-only
 * mutations) so the chunk+save logic lives in one place.
 */
export async function saveDocumentSnapshot(
  deps: ServerDeps,
  documentId: DocumentId,
  doc: LoroDoc,
): Promise<void> {
  const { manifest, chunks } = chunkSnapshot(
    doc.export({ mode: 'snapshot' }),
    SNAPSHOT_MAX_CHUNK_BYTES,
  )
  await deps.documentStore.saveSnapshot({
    docRef: { kind: 'document', documentId },
    manifest,
    chunks,
    frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
  // After the bytes are safe, and never allowed to undo them: what the
  // composition root does here (the daemon schedules a debounced
  // compaction) is not part of this write's correctness, so a scheduler
  // that throws must not turn a successful save into a failed one. The
  // observer owns reporting its own failure — server-core is a shared
  // layer with no logger to report it for them.
  try {
    await deps.documentWritten({ documentId })
  } catch {
    // Deliberately swallowed; see above and document-io.test.ts.
  }
}

/**
 * Saves a patched canvas doc. `canvas` must be the FULL `nodes`/`edges`
 * arrays (one entry replaced) — `writeSpatialCanvas` deletes any id
 * present in the doc but absent from `canvas`, so passing a lone patched
 * node/edge would silently drop every other element.
 *
 * This is a read-modify-write with no optimistic-concurrency check, same
 * as `workspace-tree-io.ts`'s `saveWorkspaceTree`: two concurrent patches
 * against the same canvas race, and the later `saveSnapshot` call wins
 * outright — the earlier patch is silently lost rather than merged. This
 * is an accepted limitation for now, not an oversight.
 */
export async function saveDocumentBodySnapshot(
  deps: ServerDeps,
  documentId: DocumentId,
  doc: LoroDoc,
  canvas: SpatialCanvas,
): Promise<void> {
  writeSpatialCanvas(doc, canvas)
  await saveDocumentSnapshot(deps, documentId, doc)
}
