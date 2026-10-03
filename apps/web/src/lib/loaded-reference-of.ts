import type { LoadedReference } from '@kamiazya/whiteboard-canvas-render'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { LoadedFileDocument } from './document-file-contract.js'

/**
 * What a daemon-loaded document is AS a reference: its canvas when the
 * workspace lists it as anything but markdown, its body otherwise. The
 * listing decides because the content cannot — a markdown document's stored form is also a
 * valid one-node canvas — and the entry is found by id when the page's
 * alias table knew one, else by the path the reference was written as,
 * which is how a legacy path reference to a canvas still draws a canvas.
 */
/** The daemon list's row, by the three fields this choice reads. */
export interface ListedDocument {
  readonly documentId: string
  readonly path: string
  readonly kind?: DocumentKind
}

export function loadedReferenceOf(
  loaded: LoadedFileDocument,
  entries: readonly ListedDocument[],
  target: string,
  documentId: string | null,
): LoadedReference | undefined {
  const entry = entries.find((candidate) =>
    documentId === null ? candidate.path === target : candidate.documentId === documentId,
  )
  const id = documentId ?? entry?.documentId
  const identity = id !== undefined ? { documentId: id } : {}
  // A listed row that names no kind is a canvas, as `readDocumentContent`
  // reads it; a document the listing does not hold at all falls to its body.
  if (entry !== undefined && entry.kind !== 'markdown') {
    return loaded.canvas === undefined ? undefined : { ...identity, canvas: loaded.canvas }
  }
  return loaded.body === undefined ? undefined : { ...identity, body: loaded.body }
}
