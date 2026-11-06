// A markdown document's body: the Loro text container it lives in.
import { type DocumentContainers, MARKDOWN_BODY_KEY } from './containers.js'
import { spliceText } from './minimal-change.js'
import { refuseRetiredShape, retiredMarkdownShape } from './retired-stored-shape.js'

/**
 * A markdown document's body: the Loro TEXT CONTAINER named `body`, which
 * every writer writes (`writeMarkdownBody`). An empty string for a document
 * with no body is the honest answer — a valid state, not a failure.
 *
 * Throws `RetiredStoredShapeError` for a body still stored as the retired
 * `okf-body` text node, which read as the container alone would be a note
 * with its prose silently gone. Not on a recorded spatial document, whose
 * body hydration reads too: a node of that id is content there.
 */
export function readMarkdownBody(doc: DocumentContainers): string {
  refuseRetiredShape(retiredMarkdownShape(doc))
  return doc.getText(MARKDOWN_BODY_KEY).toString()
}

/**
 * Replaces a markdown document's body.
 *
 * The CONTAINER is the representation, not a text node inside the spatial
 * canvas. Two reasons, and the second is the one that keeps biting:
 *
 * - It is the CRDT-native form. apps/web binds a collaborative editing
 *   session straight to it (`LoroSyncPlugin`), which a plain string field
 *   on a node cannot support — character-level merge is the whole point.
 * - Storing a body as a text NODE made a markdown document parse as a
 *   perfectly valid spatial canvas holding one node. That is why anything
 *   resolving a reference has to ask the document its kind before it can
 *   tell prose from a diagram: "does it parse as a canvas" answers yes for
 *   both. Writing the container removes the ambiguity at the source rather
 *   than guarding against it downstream.
 */
export function writeMarkdownBody(doc: DocumentContainers, body: string): void {
  writeMarkdownBodyInto(doc, body)
  doc.commit()
}

/** The body splice itself, without the commit — see `withDocumentBatch`. */
export function writeMarkdownBodyInto(doc: DocumentContainers, body: string): void {
  // Only what CHANGED. A whole-document replace is correct and ruinous:
  // every character is deleted and re-inserted, so one keystroke ships the
  // document again to every peer, grows the oplog by the document, and takes
  // every rich-text mark down with the characters it removed — which is the
  // annotation layer's passages. See `minimalChange` for the measurements.
  spliceText(doc.getText(MARKDOWN_BODY_KEY), body)
}
