import type { LoadedReference } from '@kamiazya/whiteboard-canvas-render'
import {
  readDocumentKind,
  readMarkdownBody,
  readSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { documentIdSchema, documentPathSchema, type WorkspaceId } from '@kamiazya/whiteboard-model'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import type { ServerDeps } from '../server-deps.js'

/**
 * Resolves one reference to the document it names.
 *
 * References are resolved by LOOKUP rather than by shape: a document id and
 * a document path are both plain strings whose alphabets overlap, so an id
 * that happens to look like a path (or the reverse) must not be decided by a
 * regex. The id lookup is tried first because a file node written today
 * stores an id — a path would dangle the moment the document moved — and
 * because the reader gives `[[<id>]]` the same precedence.
 */
async function resolveDocumentEntry(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  ref: string,
): Promise<DocumentEntry | null> {
  if (documentIdSchema.safeParse(ref).success) {
    const byId = await deps.documentIndex.resolveDocumentById({
      workspaceId,
      documentId: ref,
    })
    if (byId !== null) return byId
  }
  if (!documentPathSchema.safeParse(ref).success) return null
  return await deps.documentIndex.resolveDocument({ workspaceId, path: ref })
}

/**
 * The daemon's half of reference resolution: reach the store for one
 * reference and answer canvas-render's `LoadedReference`. Everything that
 * decides what the record MEANS — which seam draws what — is the shared
 * `referenceSeams`, so this is only I/O.
 *
 * `null` when nothing is indexed under the reference. A document whose
 * snapshot is gone still answers its name, so the card can say what it
 * pointed at. Only a MARKDOWN document yields a body and only a SPATIAL one
 * a canvas; the kind comes from the document itself rather than the index
 * row, because the format follows from the document (ADR-0009 decision 4)
 * and the index's `kind` is absent on rows that predate it. A markdown
 * document's stored content is also a valid canvas holding one text node,
 * so "does it parse as a canvas" cannot tell the two apart.
 */
export async function loadReferencedDocument(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  ref: string,
): Promise<LoadedReference | null> {
  const entry = await resolveDocumentEntry(deps, workspaceId, ref)
  if (entry === null) return null
  const name = entry.name !== undefined ? { name: entry.name } : {}

  const snapshot = await deps.documentStore.loadSnapshot({
    docRef: { kind: 'document', workspaceId, documentId: entry.documentId },
  })
  if (snapshot === null) return { documentId: entry.documentId, ...name }

  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(snapshot.manifest, snapshot.chunks))
  const kind = readDocumentKind(doc) ?? entry.kind
  if (kind === 'markdown') {
    return { documentId: entry.documentId, ...name, body: readMarkdownBody(doc) }
  }
  if (kind === 'spatial') {
    return { documentId: entry.documentId, ...name, canvas: readSpatialCanvas(doc) }
  }
  return { documentId: entry.documentId, ...name }
}
