import {
  readCoreFacets,
  readMarkdownBody,
  readSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { LoroDoc } from 'loro-crdt'
import type { LoadedFileDocument } from './document-file-contract.js'

/**
 * Every half of one loaded document, read in one pass. One load serves the
 * canvas, the facets and the body, so no caller pays a second store hit or a
 * second request for the half it did not ask for first.
 *
 * Both content halves are read WITHOUT choosing by kind, unlike
 * `readDocumentContent`: the embed seam takes whichever half the workspace
 * listing says it needs (`loadedReferenceOf`), and a markdown document's
 * stored form is also a valid canvas.
 */
export function readLoadedFileDocument(doc: LoroDoc, name?: string): LoadedFileDocument {
  const body = readMarkdownBody(doc)
  return {
    canvas: readSpatialCanvas(doc),
    facets: readCoreFacets(doc),
    ...(name !== undefined ? { name } : {}),
    ...(body.length > 0 ? { body } : {}),
  }
}
