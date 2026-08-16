import { readSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentId, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import type { ServerDeps } from '../server-deps.js'

/**
 * Thrown when no snapshot exists for the requested canvas. Not a Zod
 * schema — only `.message` crosses the MCP wire via the SDK's existing
 * tool-error path, so this is a plain Error subclass rather than a DTO.
 */
export class CanvasNotFoundError extends Error {
  constructor(readonly documentId: string) {
    super(`canvas not found: ${documentId}`)
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
  documentId: DocumentId,
): Promise<{ doc: LoroDoc; canvas: SpatialCanvas }> {
  const docRef = { kind: 'canvas' as const, documentId }
  const existing = await deps.documentStore.loadSnapshot({ docRef })
  if (existing === null) throw new CanvasNotFoundError(documentId)

  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(existing.manifest, existing.chunks))
  return { doc, canvas: readSpatialCanvas(doc) }
}
