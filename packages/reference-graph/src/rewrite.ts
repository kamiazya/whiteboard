import { rewriteCanvasReferences, rewriteReferenceTargets } from '@kamiazya/whiteboard-codec'
import type { DocumentContent, DocumentEdit } from '@kamiazya/whiteboard-loro-adapter'
import {
  growsPast,
  MARKDOWN_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
  nodeText,
  type SpatialCanvas,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { ReferenceRewriteTooLargeError } from './text-limit.js'

/**
 * Plans repointing one document's references by a rename plan (codec's
 * `planReferenceRewrite`: old alias to new target), from its content alone.
 * Answers the edit, or null when nothing changed — so the keeper saves only
 * what moved. Applying and saving are the keeper's, as with
 * `planLinkifyMentions`.
 *
 * The content is `readDocumentContent`'s to decide the kind of, so a document
 * that records none is rewritten as the canvas the rest of the system reads it
 * as: a markdown write over one would replace its nodes with a body.
 *
 * A new path can be longer than the old one, so a document dense with
 * references can be carried past a text ceiling. Such a document is refused
 * WHOLE, before any edit is planned — `ReferenceRewriteTooLargeError` — rather
 * than half-followed: its references keep the old path, and the keeper
 * reports it beside the documents it could not load.
 */
export function planDocumentReferenceRewrite(
  content: DocumentContent,
  plan: ReadonlyMap<string, string>,
): DocumentEdit | null {
  if (content.kind === 'spatial') {
    const result = rewriteCanvasReferences(content.canvas, plan)
    if (!result.changed) return null
    assertNodesFit(content.canvas, result.changedNodes)
    // Targeted node writes, never a whole-canvas resync: readSpatialCanvas
    // drops records the current schema cannot parse, and writing the whole
    // canvas back would DELETE them.
    return { kind: 'spatial-nodes', nodes: result.changedNodes }
  }
  const { body } = content
  const next = rewriteReferenceTargets(body, plan)
  // Kept although a body naming a planned alias is a body the rewrite
  // changes (scan and rewrite share `scanReferences`): it costs a comparison,
  // and a keeper that saved an unchanged document would report it as updated.
  if (next === body) return null
  if (growsPast(MARKDOWN_MAX_CHARS, body.length, next.length)) {
    throw new ReferenceRewriteTooLargeError({ shape: 'body', chars: next.length })
  }
  return { kind: 'markdown-body', body: next }
}

/** Refuses the rewrite when any changed node's text grew past the node ceiling. */
function assertNodesFit(canvas: SpatialCanvas, changed: readonly SpatialNode[]): void {
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
    })
  }
}
