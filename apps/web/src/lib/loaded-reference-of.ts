import type { LoadedReference } from '@kamiazya/whiteboard-canvas-render'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { LoadedFileDocument } from './document-file-contract.js'

/**
 * What a daemon-loaded document is AS a reference: its canvas when the
 * workspace lists it as spatial, its body otherwise. The listing decides
 * because the content cannot — a markdown document's stored form is also a
 * valid one-node canvas — and the entry is found by id when the page's
 * alias table knew one, else by the path the reference was written as,
 * which is how a legacy path reference to a canvas still draws a canvas.
 */
/** The daemon list's row, by the three fields this choice reads. */
export interface ListedDocument {
  readonly id: string
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
    documentId === null ? candidate.path === target : candidate.id === documentId,
  )
  const id = documentId ?? entry?.id
  const identity = id !== undefined ? { documentId: id } : {}
  if (entry?.kind === 'spatial') {
    return loaded.canvas === undefined ? undefined : { ...identity, canvas: loaded.canvas }
  }
  return loaded.body === undefined ? undefined : { ...identity, body: loaded.body }
}
