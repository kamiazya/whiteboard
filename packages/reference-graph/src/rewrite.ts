import { rewriteCanvasReferences, rewriteReferenceTargets } from '@kamiazya/whiteboard-codec'
import {
  type DocumentContainers,
  readDocumentContent,
  writeMarkdownBody,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'

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
  writeMarkdownBody(doc, next)
  return true
}
