import type { DocumentKind, SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { DocumentContainers } from './containers.js'
import { readCoreFacets, readDocumentKind } from './document-envelope.js'
import { readSpatialCanvas } from './loro-bridge.js'
import { readMarkdownBody } from './markdown-body.js'
import { refuseRetiredShape, retiredMarkdownCanvasShape } from './retired-stored-shape.js'

/**
 * What a document holds, as the one half its kind names. Discriminated so a
 * reader cannot mistake an empty canvas for a markdown document with no body.
 */
export type DocumentContent =
  | { kind: 'spatial'; canvas: SpatialCanvas }
  | { kind: 'markdown'; body: string; description?: string }

/**
 * A document's content by kind — the one place that decides which half to
 * read and what a document that names no kind is.
 *
 * The document's own recorded kind wins: it travels with the content through
 * a CRDT merge, where an index row is a keeper's local copy of it. `kind` is
 * the fallback for a document that records none — the index row, or for a
 * workspace-tree document the node meta, which is where that kind lives and
 * which no projection of the content carries.
 *
 * Recorded nowhere, a document is SPATIAL: it is the only kind that existed
 * before kinds did, and a markdown document's stored form also parses as a
 * canvas, so the opposite default would draw a pre-kind diagram as prose. A
 * markdown document whose canvas still holds the body an older writer stored
 * there is refused (`RetiredStoredShapeError`). A stored kind this build does
 * not recognise reads as recorded nowhere, as `readDocumentKind` answers it.
 */
export function readDocumentContent(doc: DocumentContainers, kind?: DocumentKind): DocumentContent {
  if ((readDocumentKind(doc) ?? kind) !== 'markdown') {
    return { kind: 'spatial', canvas: readSpatialCanvas(doc) }
  }
  // The OKF summary rides with the body because search indexes it as text the
  // document says about itself; both keepers read content through here.
  const description = readCoreFacets(doc)?.description
  refuseRetiredShape(retiredMarkdownCanvasShape(doc))
  return {
    kind: 'markdown',
    body: readMarkdownBody(doc),
    ...(description === undefined ? {} : { description }),
  }
}

/**
 * A document's content with the one thing about it that is not content: the
 * tags its OKF frontmatter carries. Both are plain values, so whatever derives
 * facts from a document (search, references, tag bearers) can run without
 * holding the document.
 */
export interface ContentWithTags {
  readonly content: DocumentContent
  /** Absent for a spatial document, whose own tags are on its canvas. */
  readonly tags?: readonly string[]
}

/** `readDocumentContent` plus the frontmatter tags of a markdown document. */
export function readContentWithTags(doc: DocumentContainers, kind?: DocumentKind): ContentWithTags {
  const content = readDocumentContent(doc, kind)
  if (content.kind !== 'markdown') return { content }
  const tags = readCoreFacets(doc)?.tags
  return tags === undefined ? { content } : { content, tags }
}
