import {
  readSpatialCanvasWithSkipped,
  reconcileSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentId, SpatialCanvas } from '@kamiazya/whiteboard-model'
import {
  chunkSnapshot,
  DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES,
  reassembleSnapshot,
} from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { getLogger } from './log.js'
import type { ServerDeps } from './server-deps.js'

const log = getLogger('document-io')

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
  workspaceId: string,
  documentId: DocumentId,
): Promise<LoadedDocument> {
  const docRef = { kind: 'document' as const, workspaceId, documentId }
  const existing = await deps.documentStore.loadSnapshot({ docRef })
  if (existing === null) throw new SnapshotNotFoundError(documentId)

  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(existing.manifest, existing.chunks))
  const { canvas, skipped } = readSpatialCanvasWithSkipped(doc)
  if (skipped > 0) {
    // Not an error: a client newer than this daemon may have written a field
    // it does not know. The save that follows leaves those records alone, and
    // this is how an operator learns the daemon is the older side.
    log.warning('canvas holds records this build cannot read; they are left as stored', {
      workspaceId,
      documentId,
      skipped,
    })
  }
  return { doc, canvas }
}

/**
 * Loads an existing canvas doc or creates a fresh one when no snapshot
 * exists yet. Used by `wb_facet_set` where setting facets on a never-saved
 * canvas is valid (unlike spatial patch tools, which require an existing
 * element to target).
 */
export async function loadOrCreateDocument(
  deps: ServerDeps,
  workspaceId: string,
  documentId: DocumentId,
): Promise<LoroDoc> {
  const docRef = { kind: 'document' as const, workspaceId, documentId }
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
  workspaceId: string,
  documentId: DocumentId,
  doc: LoroDoc,
): Promise<void> {
  const { manifest, chunks } = chunkSnapshot(
    doc.export({ mode: 'snapshot' }),
    DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES,
  )
  await deps.documentStore.saveSnapshot({
    docRef: { kind: 'document', workspaceId, documentId },
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
    // A lookup that fails costs the observer its path, not the notification:
    // compaction is addressed by workspace and needs none.
    const path = await placementOf(deps, workspaceId, documentId)
    await deps.documentWritten({
      workspaceId,
      documentId,
      doc,
      ...(path === undefined ? {} : { path }),
    })
  } catch {
    // Deliberately swallowed; see above and document-io.test.ts.
  }
}

async function placementOf(
  deps: ServerDeps,
  workspaceId: string,
  documentId: DocumentId,
): Promise<string | undefined> {
  try {
    return (await deps.documentIndex.resolveDocumentById({ workspaceId, documentId }))?.path
  } catch {
    return undefined
  }
}

/**
 * Saves a patched canvas doc. `prev` is the canvas the patch started from
 * (what `loadDocument` answered) and `next` the whole canvas after it.
 *
 * The write is a visible diff of the two (`reconcileSpatialCanvas`), never a
 * resync from `next` alone: `readSpatialCanvas` skips every stored record its
 * strict schema refuses — typically one a newer client wrote — and a resync
 * would delete each of them as an op that ships to every replica.
 *
 * This is a read-modify-write with no optimistic-concurrency check: two
 * concurrent patches against the same canvas race, and the later
 * `saveSnapshot` call wins outright — the earlier patch is silently lost
 * rather than merged. An accepted limitation, not an oversight.
 *
 * ponytail: last-write-wins on the whole canvas; a per-element compare-and-set
 * if concurrent patching turns out to be a real pattern rather than a race
 * two agents hit occasionally.
 */
export async function saveDocumentBodySnapshot(
  deps: ServerDeps,
  workspaceId: string,
  documentId: DocumentId,
  doc: LoroDoc,
  prev: SpatialCanvas,
  next: SpatialCanvas,
): Promise<void> {
  reconcileSpatialCanvas(doc, prev, next)
  await saveDocumentSnapshot(deps, workspaceId, documentId, doc)
}
