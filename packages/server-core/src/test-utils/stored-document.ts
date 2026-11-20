// A stored document as a `LoroDoc`, for a test that asserts what a tool left
// behind with the adapter's readers, or plants a stored shape below the tools.
// It reads the bytes the store holds and nothing else, so it judges the tools
// by what they stored rather than by what their own reads answer.
import { readSpatialCanvasWithSkipped } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentId, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { announceDocumentWritten, SnapshotNotFoundError, storeSnapshot } from '../document-io.js'
import type { ServerDeps } from '../server-deps.js'

const refOf = (workspaceId: string, documentId: DocumentId) => ({
  kind: 'document' as const,
  workspaceId,
  documentId,
})

/** The document as stored, with its canvas; refuses, as a tool does, when nothing was stored. */
export async function readStoredDocument(
  deps: ServerDeps,
  workspaceId: string,
  documentId: DocumentId,
): Promise<{ doc: LoroDoc; canvas: SpatialCanvas }> {
  const doc = await readStoredDocumentOrEmpty(deps, workspaceId, documentId, true)
  return { doc, canvas: readSpatialCanvasWithSkipped(doc).canvas }
}

/** The document as stored, or an empty one when nothing was stored. */
export async function readStoredDocumentOrEmpty(
  deps: ServerDeps,
  workspaceId: string,
  documentId: DocumentId,
  mustExist = false,
): Promise<LoroDoc> {
  const existing = await deps.documentStore.loadSnapshot({
    docRef: refOf(workspaceId, documentId),
  })
  if (existing === null && mustExist) throw new SnapshotNotFoundError(documentId)
  const doc = new LoroDoc()
  if (existing !== null) doc.import(reassembleSnapshot(existing.manifest, existing.chunks))
  return doc
}

/** Stores `doc` as the document, and tells the document-written observer as a tool's save does. */
export async function writeStoredDocument(
  deps: ServerDeps,
  workspaceId: string,
  documentId: DocumentId,
  doc: LoroDoc,
): Promise<void> {
  await storeSnapshot(
    deps,
    { workspaceId, documentId },
    doc.export({ mode: 'snapshot' }),
    doc.oplogVersion().encode(),
  )
  await announceDocumentWritten(deps, workspaceId, documentId)
}
