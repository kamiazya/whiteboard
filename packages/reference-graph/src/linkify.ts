import { documentReferenceMarkup } from '@kamiazya/whiteboard-codec'
import {
  type DocumentContainers,
  MARKDOWN_BODY_KEY,
  readSpatialCanvas,
  reconcileSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  type DocumentKind,
  nodeText,
  spatialCanvasSchema,
  withNodeText,
} from '@kamiazya/whiteboard-model'
import { unlinkedNameSpans } from './reference-aggregate.js'

/** The document a mention names, as a listing knows it. */
export interface LinkifyTarget {
  readonly documentId: string
  readonly path: string
  /** Required: a document with no display name is named nowhere in prose. */
  readonly name: string
}

/**
 * How a mention of `target` is written as a link: its name as the label of a
 * reference the codec's writer spells, so a name the reader could not read
 * inside the brackets (`Arrays [0]`) falls back to the bare reference — which
 * the renderer labels with that same name — instead of being written raw and
 * truncated by the scanner.
 */
export function linkMarkupFor(target: LinkifyTarget): string {
  return documentReferenceMarkup(
    { id: target.documentId, path: target.path, name: target.name },
    target.name,
  )
}

/**
 * Turns a source document's unlinked mentions of `target` into links, IN
 * PLACE, and answers how many. Commits only when something changed, so a
 * source with nothing to link writes nothing. Saving is the keeper's: this
 * works on whatever holds the document — a standalone doc on the daemon, a
 * node of the workspace record in the browser — which is what
 * `DocumentContainers` is for.
 *
 * A markdown body is edited by targeted text splices (reverse order, one
 * commit), so a concurrent edit elsewhere in the body merges instead of being
 * clobbered by a whole-body replace.
 *
 * A canvas rewrites TEXT NODES only: a `[[link]]` in a label renders as
 * literal brackets, so labels are mention-detected and never rewritten. The
 * canvas is written as a visible diff against the canvas that was read, so
 * only the rewritten nodes are touched: lines, tags, facets and comments are
 * not this operation's to change, and a record the reader skipped (a newer
 * client's) is not this operation's to delete.
 */
export function linkifyMentionsIn(
  doc: DocumentContainers,
  kind: DocumentKind,
  target: LinkifyTarget,
): number {
  const markup = linkMarkupFor(target)
  if (kind === 'markdown') {
    const text = doc.getText(MARKDOWN_BODY_KEY)
    const spans = unlinkedNameSpans(text.toString(), target.name)
    for (const span of [...spans].reverse()) {
      text.delete(span.index, span.length)
      text.insert(span.index, markup)
    }
    if (spans.length > 0) doc.commit()
    return spans.length
  }

  const canvas = readSpatialCanvas(doc)
  let linked = 0
  const nodes = canvas.nodes.map((node) => {
    const text = nodeText(node)
    if (text === undefined) return node
    const result = rewriteMentions(text, target.name, markup)
    linked += result.count
    return result.count === 0 ? node : withNodeText(node, result.text)
  })
  if (linked > 0)
    reconcileSpatialCanvas(doc, canvas, spatialCanvasSchema.parse({ ...canvas, nodes }))
  return linked
}

function rewriteMentions(
  text: string,
  name: string,
  markup: string,
): { text: string; count: number } {
  const spans = unlinkedNameSpans(text, name)
  let out = text
  // Reverse order so earlier spans' offsets stay valid while later ones are
  // spliced.
  for (const span of [...spans].reverse()) {
    out = out.slice(0, span.index) + markup + out.slice(span.index + span.length)
  }
  return { text: out, count: spans.length }
}
