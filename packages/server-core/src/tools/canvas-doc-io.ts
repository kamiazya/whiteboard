import type { CanvasId, SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import type { ServerDeps } from '../create-server.js'
import { CanvasDocNotFoundError } from './errors.js'

/**
 * A single chunk always fits Loro's snapshot output for the geometry/text
 * mutations these patch tools perform; this cap only matters once a
 * store/sync implementation enforces its own message-size limit, which is
 * out of this shared layer's scope.
 */
const SNAPSHOT_MAX_CHUNK_BYTES = 1_000_000

export interface LoadedCanvasDoc {
  doc: LoroDoc
  canvas: SpatialCanvas
}

/**
 * Loads a canvas doc for patching. Unlike `facet_set` (which tolerates a
 * missing doc — facets can be set on a brand-new canvas), a patch targets
 * an *existing* element by id, so there is nothing sensible to patch in a
 * doc that has never been saved. This deliberately throws instead of
 * falling back to an empty `LoroDoc`.
 */
export async function loadCanvasDoc(
  deps: ServerDeps,
  canvasId: CanvasId,
): Promise<LoadedCanvasDoc> {
  const docRef = { kind: 'canvas' as const, canvasId }
  const existing = await deps.canvasDocStore.loadSnapshot({ docRef })
  if (existing === null) throw new CanvasDocNotFoundError(canvasId)

  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(existing.manifest, existing.chunks))
  return { doc, canvas: readSpatialCanvas(doc) }
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
export async function saveCanvasDoc(
  deps: ServerDeps,
  canvasId: CanvasId,
  doc: LoroDoc,
  canvas: SpatialCanvas,
): Promise<void> {
  writeSpatialCanvas(doc, canvas)
  const { manifest, chunks } = chunkSnapshot(
    doc.export({ mode: 'snapshot' }),
    SNAPSHOT_MAX_CHUNK_BYTES,
  )
  await deps.canvasDocStore.saveSnapshot({
    docRef: { kind: 'canvas', canvasId },
    manifest,
    chunks,
    frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
}
