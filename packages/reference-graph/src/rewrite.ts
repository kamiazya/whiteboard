import { rewriteCanvasReferences, rewriteReferenceTargets } from '@kamiazya/whiteboard-codec'
import {
  type DocumentContainers,
  MARKDOWN_BODY_KEY,
  NODES_KEY,
  readDocumentContent,
  writeMarkdownBody,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  type DocumentKind,
  growsPast,
  MARKDOWN_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
  nodeText,
  type SpatialCanvas,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { ReferenceRewriteTooLargeError } from './text-limit.js'

/**
 * Repoints one document's references IN PLACE by a rename plan (codec's
 * `planReferenceRewrite`: old alias to new target), and answers whether
 * anything changed — so the keeper saves only what moved. Saving is the
 * keeper's, as with `linkifyMentionsIn`: this works on whatever holds the
 * document, a standalone doc on the daemon or a node of the browser's
 * workspace record.
 *
 * The kind is `readDocumentContent`'s to decide, so a document that records
 * none is rewritten as the canvas the rest of the system reads it as: a
 * markdown write over one would replace its nodes with a body.
 *
 * A new path can be longer than the old one, so a document dense with
 * references can be carried past a text ceiling. Such a document is refused
 * WHOLE, before anything is written — `ReferenceRewriteTooLargeError` — rather
 * than half-followed: its references keep the old path, and the keeper
 * reports it beside the documents it could not load.
 */
export function rewriteDocumentReferences(
  doc: DocumentContainers,
  plan: ReadonlyMap<string, string>,
  entryKind: DocumentKind | undefined,
): boolean {
  const content = readDocumentContent(doc, entryKind)
  if (content.kind === 'spatial') {
    const result = rewriteCanvasReferences(content.canvas, plan)
    if (!result.changed) return false
    assertNodesFit(doc, content.canvas, result.changedNodes)
    // Targeted writes, never a whole-canvas resync: readSpatialCanvas drops
    // records the current schema cannot parse, and writing the whole canvas
    // back would DELETE them.
    for (const node of result.changedNodes) writeSpatialNode(doc, node)
    return true
  }
  const { body } = content
  const next = rewriteReferenceTargets(body, plan)
  // Kept although a body naming a planned alias is a body the rewrite
  // changes (scan and rewrite share `scanReferences`): it costs a comparison,
  // and a keeper that saved an unchanged document would report it as updated.
  if (next === body) return false
  if (growsPast(MARKDOWN_MAX_CHARS, body.length, next.length)) {
    throw new ReferenceRewriteTooLargeError({
      shape: 'body',
      chars: next.length,
      container: doc.getText(MARKDOWN_BODY_KEY).id,
    })
  }
  writeMarkdownBody(doc, next)
  return true
}

/** Refuses the rewrite when any changed node's text grew past the node ceiling. */
function assertNodesFit(
  doc: DocumentContainers,
  canvas: SpatialCanvas,
  changed: readonly SpatialNode[],
): void {
  for (const node of changed) {
    const after = nodeText(node)
    if (after === undefined) continue
    const before = canvas.nodes.find((held) => held.id === node.id)
    const beforeLength = (before === undefined ? undefined : nodeText(before))?.length ?? 0
    if (!growsPast(NODE_TEXT_MAX_CHARS, beforeLength, after.length)) continue
    throw new ReferenceRewriteTooLargeError({
      shape: 'node-text',
      chars: after.length,
      nodeId: node.id,
      container: doc.getMap(NODES_KEY).id,
    })
  }
}
