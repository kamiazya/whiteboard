import { readDocumentKind, readSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentId, SpatialCanvas, WorkspaceId } from '@kamiazya/whiteboard-model'
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

/**
 * Thrown when a scene tool is pointed at a document whose kind says it is
 * not spatial. Without this, a markdown document — whose body lives outside
 * the nodes/edges containers — digested or rendered as an EMPTY scene with
 * no error, indistinguishable from a genuinely empty spatial canvas.
 */
class NotASpatialDocumentError extends Error {
  constructor(documentId: string, kind: string, toolName: string) {
    super(
      `Document ${documentId} is a ${kind} document; ${toolName} projects spatial scenes only. Read it with wb_document_get instead.`,
    )
    this.name = 'NotASpatialDocumentError'
  }
}

/**
 * Refuses a document KNOWN to be markdown: the doc's own recorded kind
 * wins, the workspace-scoped index row is the fallback (mirroring
 * wb_document_get's read path). A document with no recorded kind anywhere
 * passes — pre-kind spatial documents must keep working, so only a
 * positively-known markdown document is refused.
 */
export async function assertSpatialDocument(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  doc: LoroDoc,
  toolName: string,
): Promise<void> {
  const docKind = readDocumentKind(doc)
  const kind =
    docKind ?? (await deps.documentIndex.resolveDocumentById({ workspaceId, documentId }))?.kind
  if (kind === 'markdown') {
    throw new NotASpatialDocumentError(documentId, kind, toolName)
  }
}
