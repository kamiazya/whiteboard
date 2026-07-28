import type { CanvasId } from '@kamiazya/whiteboard-canvas-model'
import { reassembleSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import { readSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { LoroDoc } from 'loro-crdt'
import type { ServerDeps } from '../create-server.js'

/**
 * Thrown when no snapshot exists for the requested canvas. Not a Zod
 * schema — only `.message` crosses the MCP wire via the SDK's existing
 * tool-error path, so this is a plain Error subclass rather than a DTO.
 */
export class CanvasNotFoundError extends Error {
  constructor(readonly canvasId: string) {
    super(`canvas not found: ${canvasId}`)
    this.name = 'CanvasNotFoundError'
  }
}

/**
 * Loads a canvas doc's snapshot, rebuilds the LoroDoc, and decodes its
 * spatial content. Returns the still-open `doc` alongside `canvas` so a
 * caller needing another doc-derived view (e.g. facets, for OKF export)
 * does not have to round-trip `loadSnapshot` a second time.
 */
export async function loadSpatialCanvas(
  deps: ServerDeps,
  canvasId: CanvasId,
): Promise<{ doc: LoroDoc; canvas: SpatialCanvas }> {
  const docRef = { kind: 'canvas' as const, canvasId }
  const existing = await deps.canvasDocStore.loadSnapshot({ docRef })
  if (existing === null) throw new CanvasNotFoundError(canvasId)

  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(existing.manifest, existing.chunks))
  return { doc, canvas: readSpatialCanvas(doc) }
}
