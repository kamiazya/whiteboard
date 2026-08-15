import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'

/**
 * The stored id of the one text node a markdown document's body lives in on
 * this side. `wb_document_set` writes it; `isMarkdownShaped` recognises a
 * document by it.
 */
export const MARKDOWN_BODY_NODE_ID = 'okf-body'

/**
 * Reads a markdown document's body out of its stored form.
 *
 * A markdown document's content on this side IS a spatial canvas holding a
 * single text node — `wb_document_set` writes exactly that, and it is why a
 * markdown document also parses as a perfectly valid (if odd) canvas. That
 * representation is a storage detail, so every reader of it goes through
 * this one function rather than repeating the node lookup.
 *
 * Note this is NOT how apps/web's browser-local store holds a markdown body
 * (it uses a Loro text container named `body`). The two sides genuinely
 * differ; neither reads the other's documents today, and unifying them is a
 * larger change than any single reader should make in passing.
 *
 * Falls back to the FIRST text node rather than requiring the id, because
 * documents written before the id was stable still have to export. An empty
 * string for a document with no text node at all is the honest answer: it
 * has no body, which is a valid state.
 */
export function readMarkdownDocumentBody(canvas: SpatialCanvas): string {
  const byId = canvas.nodes.find((node) => node.id === MARKDOWN_BODY_NODE_ID)
  if (byId?.type === 'text') return byId.text
  return canvas.nodes.find((node) => node.type === 'text')?.text ?? ''
}
