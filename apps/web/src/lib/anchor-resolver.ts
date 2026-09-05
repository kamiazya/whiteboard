/**
 * Whether each of a document's conversations still finds its place, for the
 * rail's `resolveAnchor` — ONE reader for both keeper pages and both
 * document kinds, so the answer cannot be decided twice (the two pages each
 * carried a copy, and each copy judged only the node reference: an edge
 * comment whose edge was gone, and a passage whose node was gone, both read
 * as placed).
 *
 * The judgement follows the anchor's own structure (model's
 * `annotationAnchorSchema`): an object REFERENCE is judged against the
 * document — the node, the edge, the node's text — and an anchor with no
 * reference, or one about a surface this document does not have, is
 * `placed`: "not something I can tell you about" is not "lost".
 * `undefined` means the document has not loaded yet, which is not the same
 * as any passage being gone.
 */
import type { AnnotationAnchor, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { resolveTextAnchor } from './text-anchor.js'

export type AnchorPlacement = 'placed' | 'orphaned'
export type AnchorResolver = (thread: { readonly anchor: AnnotationAnchor }) => AnchorPlacement

export type AnchorResolverSubject =
  | { readonly kind: 'markdown'; readonly body: string | null }
  | { readonly kind: 'spatial'; readonly canvas: SpatialCanvas }

export function anchorResolverFor(subject: AnchorResolverSubject): AnchorResolver | undefined {
  if (subject.kind === 'markdown') {
    const { body } = subject
    if (body === null) return undefined
    return ({ anchor }) => {
      // A passage of a NODE's text is about a surface a note does not have.
      if (anchor.kind !== 'text' || anchor.nodeId !== undefined) return 'placed'
      return resolveTextAnchor(body, anchor).kind
    }
  }
  const { canvas } = subject
  const nodes = new Map(canvas.nodes.map((node) => [node.id, node]))
  const edgeIds = new Set(canvas.edges.map((edge) => edge.id))
  return ({ anchor }) => {
    if (anchor.kind === 'spatial') {
      if (anchor.nodeId !== undefined) return nodes.has(anchor.nodeId) ? 'placed' : 'orphaned'
      if (anchor.edgeId !== undefined) return edgeIds.has(anchor.edgeId) ? 'placed' : 'orphaned'
      // A set is about its members: placed while any of them is, since the
      // outline still has something to enclose.
      if (anchor.nodeIds !== undefined)
        return anchor.nodeIds.some((id) => nodes.has(id)) ? 'placed' : 'orphaned'
      return 'placed'
    }
    // The document itself cannot be gone while it is being read.
    if (anchor.kind !== 'text') return 'placed'
    if (anchor.nodeId === undefined) return 'placed'
    const node = nodes.get(anchor.nodeId)
    if (node === undefined || node.type !== 'text') return 'orphaned'
    return resolveTextAnchor(node.text, anchor).kind
  }
}
