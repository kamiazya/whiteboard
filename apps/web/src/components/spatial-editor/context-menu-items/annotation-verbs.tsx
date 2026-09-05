/**
 * The annotation layer's rows, defined once and worn by three menus.
 *
 * Under Select each object's menu carries its own comment verb among its
 * edit verbs — a node's beside Lock, an edge's beside Edit label, empty
 * space's after the creation set. Under the hand tool the SAME rows are the
 * whole menu: panning keeps content out of reach (a press pans, nothing
 * selects, nothing edits) while a conversation about what is on screen
 * stays one right-click or long-press away, exactly as it is under Select.
 * One definition per row is what keeps the two readings equal — a verb
 * added to one menu and not the other is the drift the surface-parity
 * matrix exists to catch, one level up.
 */
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { Eye, EyeOff, MessageSquare, MessageSquarePlus } from 'lucide-react'
import type { Point } from '../../../lib/spatial/viewport.js'
import type { CanvasCommands } from '../CanvasContextMenu.js'
import type { ContextMenuItem } from '../ContextMenu.js'

type SetCommentCompose = CanvasCommands['setCommentCompose']

/**
 * Anchored at the node's top-right corner, the same convention the MCP
 * `comment` op uses, so a comment reads the same whoever made it. A comment
 * is ABOUT the node and never touches it, which is why it is the one verb a
 * LOCKED node keeps beside Unlock — and the one the hand tool keeps at all.
 */
export function commentOnNodeItem(
  node: SpatialNode,
  setCommentCompose: SetCommentCompose,
): ContextMenuItem {
  return {
    label: 'Comment on this',
    icon: <MessageSquarePlus />,
    onSelect: () =>
      setCommentCompose({
        point: { x: node.x + node.width, y: node.y },
        targetNodeId: node.id,
      }),
  }
}

/**
 * The point pressed is what the comment stores, and the layer pins it on
 * the edge's routed path from there (canvas-render's `commentAnchor`), so
 * it rides a reroute.
 */
export function commentOnEdgeItem(
  edge: CanvasEdge,
  point: Point,
  setCommentCompose: SetCommentCompose,
): ContextMenuItem {
  return {
    label: 'Comment on this',
    icon: <MessageSquare />,
    onSelect: () =>
      setCommentCompose({
        point: { x: Math.round(point.x), y: Math.round(point.y) },
        targetEdgeId: edge.id,
      }),
  }
}

/** A comment about a spot: anchored at the pressed point, about no object. */
export function commentHereItem(
  point: Point,
  setCommentCompose: SetCommentCompose,
): ContextMenuItem {
  return {
    label: 'Comment here',
    icon: <MessageSquarePlus />,
    onSelect: () => setCommentCompose({ point }),
  }
}

/**
 * Resolved comments stay in the document; this is the one way to see them
 * again (and reopen one). View state, per user (ADR-0025 decision 2).
 */
export function resolvedCommentsItem(
  showResolvedComments: boolean,
  setShowResolvedComments: CanvasCommands['setShowResolvedComments'],
): ContextMenuItem {
  return {
    label: showResolvedComments ? 'Hide resolved comments' : 'Show resolved comments',
    icon: showResolvedComments ? <EyeOff /> : <Eye />,
    onSelect: () => setShowResolvedComments(!showResolvedComments),
  }
}

export interface AnnotationVerbItemsInput {
  /** The node under the press, if any: its verb is the menu. */
  readonly node: SpatialNode | undefined
  /** The edge under the press when no node is: its verb is the menu. */
  readonly edge: CanvasEdge | undefined
  readonly point: Point
  readonly setCommentCompose: SetCommentCompose
  readonly showResolvedComments: boolean
  readonly setShowResolvedComments: CanvasCommands['setShowResolvedComments']
}

/** The hand tool's whole menu: the annotation verb for what is under the press. */
export function annotationVerbItems({
  node,
  edge,
  point,
  setCommentCompose,
  showResolvedComments,
  setShowResolvedComments,
}: AnnotationVerbItemsInput): ContextMenuItem[] {
  if (node !== undefined) return [commentOnNodeItem(node, setCommentCompose)]
  if (edge !== undefined) return [commentOnEdgeItem(edge, point, setCommentCompose)]
  return [
    commentHereItem(point, setCommentCompose),
    resolvedCommentsItem(showResolvedComments, setShowResolvedComments),
  ]
}
