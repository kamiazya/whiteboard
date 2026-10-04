// A markdown document's body: the Loro text container it lives in, and the
// legacy node-side shape an older writer left, read but never written.
import {
  nodeKind,
  nodeText,
  type SpatialCanvas,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { type DocumentContainers, EDGES_KEY, MARKDOWN_BODY_KEY, NODES_KEY } from './containers.js'
import { readSpatialCanvas, writeSpatialCanvasInto } from './loro-bridge.js'
import { spliceText } from './minimal-change.js'

/**
 * The stored id of the single text node a markdown document's body lives in
 * on older daemon documents. Nothing writes it — `document.set`
 * writes the text container — but stored documents still hold one, so it is
 * how a reader finds such a body and how that tool recognises a document it
 * could itself have written.
 */
export const MARKDOWN_BODY_NODE_ID = 'okf-body'

/**
 * A markdown document's body, whichever way this codebase stored it.
 *
 * Every writer now writes the Loro TEXT CONTAINER named `body`
 * (`writeMarkdownBody`). It did not start that way: `document.set` used
 * to store the body as a single `okf-body` TEXT NODE inside the spatial
 * canvas — which is why a markdown document also parsed as a perfectly
 * valid, if odd, canvas — while apps/web's editor wrote the container so a
 * CRDT editing session had something to bind to. Neither side could read
 * the other's documents until this function existed, and stored documents
 * still hold the old shape, so it keeps reading both.
 *
 * The container wins when both are present: writers supersede the node
 * rather than removing it in a migration, so where both exist the container
 * is the newer one.
 *
 * Falls back to the FIRST text node rather than requiring the id, because
 * documents written before the id was stable still have to be readable. An
 * empty string for a document with no body at all is the honest answer: it
 * has no body, which is a valid state, not a failure.
 */
export function readMarkdownBody(doc: DocumentContainers): string {
  const container = doc.getText(MARKDOWN_BODY_KEY).toString()
  if (container.length > 0) return container

  return markdownBodyFromCanvas(readSpatialCanvas(doc))
}

/**
 * The node a markdown document's body lives in, given an already-read
 * canvas: the stable id first, then the first text node (pre-stable-id
 * documents), matching `readMarkdownBody`'s node-side selection exactly.
 *
 * Asks the content seam what a node HOLDS rather than narrowing on the
 * stored discriminant, so it says the same thing before and after ADR-0038
 * decision 3 dissolves that union. It answers a `SpatialNode` rather than a
 * narrowed type derived from the union itself — the only thing the caller
 * wants from that narrowing is `.text`, which `nodeText` gives without it.
 */
function findMarkdownBodyNode(nodes: SpatialCanvas['nodes']): SpatialNode | undefined {
  const byId = nodes.find((node) => node.id === MARKDOWN_BODY_NODE_ID)
  if (byId !== undefined && nodeKind(byId) === 'text') return byId
  return nodes.find((node) => nodeKind(node) === 'text')
}

/**
 * The node-side half of `readMarkdownBody`. Private on purpose: it is a
 * legacy READ fallback for documents an older writer left, and exporting it
 * is what let a caller treat the node as a live representation to write.
 */
function markdownBodyFromCanvas(canvas: SpatialCanvas): string {
  const node = findMarkdownBodyNode(canvas.nodes)
  return (node === undefined ? undefined : nodeText(node)) ?? ''
}

/**
 * Replaces a markdown document's body, and makes the document stop being a
 * spatial canvas at the same time.
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
 *   both. Writing the container and emptying the canvas removes the
 *   ambiguity at the source rather than guarding against it downstream.
 *
 * Clearing the canvas also supersedes a legacy `okf-body` node left by the
 * older writer, so a rewritten document cannot keep a stale second body for
 * a later reader to find.
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
  // Only when there is something to clear. This runs on every keystroke in
  // the browser editor, where the canvas is already empty and an
  // unconditional rewrite would add CRDT operations — and a save — for a
  // change nobody made.
  if (doc.getMap(NODES_KEY).size > 0 || doc.getMap(EDGES_KEY).size > 0) {
    writeSpatialCanvasInto(doc, { nodes: [], edges: [] })
  }
}
