import type { SpatialCanvas, StoredCoreFacets } from '@kamiazya/whiteboard-model'
import type { LoadedFileDocument } from './document-file-contract.js'

/** The three halves of one document, as a reader answered each. */
export interface LoadedFileHalves {
  readonly canvas: SpatialCanvas
  readonly facets: StoredCoreFacets | undefined
  readonly body: string
}

/**
 * Every half of one loaded document, in the shape the embed seam takes. One
 * load serves the canvas, the facets and the body, so no caller pays a second
 * store hit or a second request for the half it did not ask for first.
 *
 * Both content halves are carried WITHOUT choosing by kind, unlike
 * `readDocumentContent`: the embed seam takes whichever half the workspace
 * listing says it needs (`loadedReferenceOf`), and a markdown document's
 * stored form is also a valid canvas.
 */
export function loadedFileDocument(halves: LoadedFileHalves, name?: string): LoadedFileDocument {
  return {
    canvas: halves.canvas,
    facets: halves.facets,
    ...(name !== undefined ? { name } : {}),
    ...(halves.body.length > 0 ? { body: halves.body } : {}),
  }
}
