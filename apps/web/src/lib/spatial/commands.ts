/**
 * `EditorCommand` is the single, pure, immutable mutation point for the
 * spatial editor: every gesture that changes the canvas produces one of
 * these, and `applyCommand` turns it into a NEW `SpatialCanvas` value —
 * the input is never mutated.
 *
 * This is a process-internal type (it never crosses a process boundary in
 * this slice), so per zod-schema-discipline it deliberately has no Zod
 * schema. If a later slice serializes commands to the sync layer, that is
 * the point to add one.
 *
 * `applyCommand` is total: a command whose target id is missing, or whose
 * kind does not apply to the target node's type, returns the INPUT canvas
 * unchanged rather than throwing. `create-node` carries a full model
 * `SpatialNode` (rather than a flattened x/y/w/h/text tuple) so a later node
 * kind needs no command-shape change; a colliding id is likewise a no-op.
 * `delete-node` cascades: it also removes every edge whose `fromNode`/
 * `toNode` referenced the removed node, so no command sequence can ever
 * produce a canvas with a dangling edge endpoint.
 */

import {
  type CanvasColor,
  type CanvasComment,
  type CanvasEdge,
  type ClipboardFragment,
  type CommentMessage,
  type CommentThread,
  canvasCommentFromThread,
  type EdgeRoutingStyle,
  type LineJumps,
  type SpatialCanvas,
  type SpatialNode,
  type StoredCoreFacets,
} from '@kamiazya/whiteboard-model'
import { resolveCanvasEdgeStyle, VISUAL_EDGES_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { remintClipboardFragment } from '../clipboard-fragment.js'
import type { Point } from './viewport.js'

export type EditorLeafCommand =
  | { readonly kind: 'move-node'; readonly id: string; readonly x: number; readonly y: number }
  | {
      readonly kind: 'resize-node'
      readonly id: string
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
    }
  | { readonly kind: 'set-text'; readonly id: string; readonly text: string }
  | {
      readonly kind: 'connect-nodes'
      readonly edgeId: string
      readonly fromNode: string
      readonly toNode: string
    }
  | { readonly kind: 'create-node'; readonly node: SpatialNode }
  | { readonly kind: 'delete-node'; readonly id: string }
  | {
      /**
       * Appends a full edge verbatim (sides/ends/color/label preserved) —
       * what duplicate/paste re-create edges with; `connect-nodes` only
       * carries endpoints. Total: duplicate id, missing endpoint, and
       * self-loop are no-ops.
       */
      readonly kind: 'create-edge'
      readonly edge: CanvasEdge
    }
  | {
      /**
       * Z-order move. Array order IS z-order in JSON Canvas (last = topmost),
       * so this is a pure permutation of `nodes`. A multi-selection moves as
       * ONE block preserving its relative order; forward/backward step the
       * block over the nearest non-member above/below it.
       */
      readonly kind: 'reorder-nodes'
      readonly ids: readonly string[]
      readonly placement: 'forward' | 'backward' | 'front' | 'back'
    }
  | { readonly kind: 'delete-edge'; readonly id: string }
  | { readonly kind: 'set-edge-label'; readonly id: string; readonly label: string }
  | {
      readonly kind: 'set-edge-ends'
      readonly id: string
      readonly fromEnd: 'none' | 'arrow'
      readonly toEnd: 'none' | 'arrow'
    }
  | {
      readonly kind: 'set-node-color'
      readonly id: string
      // undefined returns the object to the theme default (field removed).
      readonly color: CanvasColor | undefined
    }
  | {
      /**
       * Writes one facet on one node. Deliberately facet-GENERIC: the key
       * comes from the caller (a facet widget, the extension side of the
       * contribution seam), so this module never names a domain.
       */
      readonly kind: 'set-node-facet'
      readonly id: string
      readonly key: string
      // undefined removes the facet — for a facet whose absence IS a value
      // (visual.shape's rect), that is how the default is restored.
      readonly payload: unknown
    }
  | {
      // Edits the canvas ENVELOPE rather than its contents, so it names no
      // node: routing style is a property of the canvas, and per-edge
      // overrides are a later, separate command.
      readonly kind: 'set-edge-routing'
      readonly style: EdgeRoutingStyle
    }
  | {
      // Canvas-envelope sibling of set-edge-routing: whether crossing
      // edges hop over each other. Same later-per-edge-override caveat.
      readonly kind: 'set-line-jumps'
      readonly lineJumps: LineJumps
    }
  | {
      readonly kind: 'set-edge-color'
      readonly id: string
      readonly color: CanvasColor | undefined
    }
  | {
      // Creates a group frame at the BOTTOM of the z-order (array start),
      // so hit-testing (last containing box wins) still reaches members
      // drawn above it. A colliding id is a no-op, like create-node.
      readonly kind: 'create-group'
      readonly node: Extract<SpatialNode, { type: 'group' }>
    }
  | {
      // Sets a group frame's label; an empty string removes the field
      // (canonical form, like set-edge-label). Non-group targets no-op.
      readonly kind: 'set-group-label'
      readonly id: string
      readonly label: string
    }
  | {
      // Sets or restyles a group frame's background image (JSON Canvas
      // group.background/backgroundStyle); omitting `background` removes
      // both fields. Non-group targets no-op.
      readonly kind: 'set-group-background'
      readonly id: string
      readonly background?: string
      readonly backgroundStyle?: 'cover' | 'ratio' | 'repeat'
    }
  | {
      // Retargets a file node at another document. A stale subpath from the
      // old target has no meaning in the new one, so it is always cleared.
      readonly kind: 'set-node-file'
      readonly id: string
      readonly file: string
    }
  | {
      // Rewrites a link node's destination. Only link nodes carry a url —
      // any other target (or a missing id) is a no-op, never a corruption.
      readonly kind: 'set-node-url'
      readonly id: string
      readonly url: string
    }
  | {
      readonly kind: 'set-edge-side'
      readonly id: string
      readonly endpoint: 'from' | 'to'
      // undefined returns the endpoint to derived (auto) routing.
      readonly side: 'top' | 'right' | 'bottom' | 'left' | undefined
    }
  | {
      // Appends one comment verbatim (ADR-0024's annotation layer). A
      // colliding id is a no-op, like create-node/create-edge.
      readonly kind: 'create-comment'
      readonly comment: CanvasComment
    }
  | {
      // Rewrites one comment's `resolved` field. A missing target id is a
      // no-op, matching every other single-field write in this union.
      readonly kind: 'set-comment-resolved'
      readonly id: string
      readonly resolved: boolean
    }
  | {
      // Rewrites one comment's stored anchor. Meaningful for a point-anchored
      // comment; on a node-anchored one it only moves the fallback the layer
      // draws at when the target is gone. A missing id is a no-op.
      readonly kind: 'move-comment'
      readonly id: string
      readonly x: number
      readonly y: number
    }
  | {
      // Rewrites one comment's text. A missing id is a no-op.
      readonly kind: 'set-comment-text'
      readonly id: string
      readonly text: string
    }
  | {
      /**
       * Appends a message to an existing conversation (ADR-0026 decision 2).
       *
       * The one command in this union that leaves the CANVAS untouched: a
       * reply changes no node and no edge, and it cannot travel through the
       * `x-whiteboard.comments` envelope the other comment commands use,
       * because that shape holds a single `text` per comment with nowhere
       * for a second message to sit. It is committed by writing the thread's
       * messages map directly — see the sync session's own case for it.
       *
       * It stays a command rather than a session method so a reply is one
       * undo step like every other edit, and so the annotation channel
       * republishes on the same path.
       */
      readonly kind: 'reply-to-thread'
      readonly threadId: string
      readonly message: CommentMessage
    }
  | {
      /**
       * Opens a conversation whose anchor a flat comment cannot carry — a
       * passage of a node's text, today. The thread itself is what the sync
       * session writes; on the canvas it appears as its projection (a
       * comment on the node, at its corner), appended so the renderer draws
       * a pin without waiting for the annotation channel. A colliding id is
       * a no-op, like create-comment.
       */
      readonly kind: 'create-thread'
      readonly thread: CommentThread
    }

/**
 * One user action composed of N leaf commands (paste, duplicate,
 * multi-delete). The two-type split (rather than a self-referential union)
 * type-forbids nested batches, mirroring the sync layer's one-commit rule.
 * Application is a pure fold; the one-Loro-commit/one-undo-step guarantee
 * lives in document-sync-session's batch write path, not here.
 */
export type EditorCommand =
  | EditorLeafCommand
  | { readonly kind: 'batch'; readonly commands: readonly EditorLeafCommand[] }
  /**
   * A markdown document's whole body, written to the doc's `body` text
   * container. Deliberately NOT an `EditorLeafCommand`: it targets no node
   * and no edge, leaves the `SpatialCanvas` value untouched, and can never
   * appear inside a batch — the spatial editor does not issue it. It rides
   * the command path anyway so a body edit gets the same debounce, undo step
   * and local-update push as every other change, instead of a second write
   * pipeline beside them.
   */
  | { readonly kind: 'set-body'; readonly text: string }
  /**
   * A markdown document's OKF core facets, written to the doc's `core` map.
   * Same class as `set-body` and not an `EditorLeafCommand` for the same
   * reasons: no node, no edge, canvas value untouched, never in a batch.
   */
  | { readonly kind: 'set-facets'; readonly facets: StoredCoreFacets }

/** spatialCanvasSchema requires integer x/y and non-negative integer w/h. */
function toPosition(value: number): number {
  return Math.round(value)
}

function toSize(value: number): number {
  return Math.max(0, Math.round(value))
}

/**
 * Replaces the node with `id` by `update(node)`. Returns the input canvas
 * unchanged when the node is missing or `update` declines it (returns
 * undefined) — the totality guarantee documented above.
 */
function updateNode(
  canvas: SpatialCanvas,
  id: string,
  update: (node: SpatialNode) => SpatialNode | undefined,
): SpatialCanvas {
  const index = canvas.nodes.findIndex((node) => node.id === id)
  const target = index === -1 ? undefined : canvas.nodes[index]
  if (target === undefined) return canvas
  const updated = update(target)
  if (updated === undefined) return canvas
  const nodes = canvas.nodes.slice()
  nodes[index] = updated
  return { ...canvas, nodes }
}

function moveNode(canvas: SpatialCanvas, id: string, x: number, y: number): SpatialCanvas {
  return updateNode(canvas, id, (node) => ({ ...node, x: toPosition(x), y: toPosition(y) }))
}

function resizeNode(
  canvas: SpatialCanvas,
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): SpatialCanvas {
  return updateNode(canvas, id, (node) => ({
    ...node,
    x: toPosition(x),
    y: toPosition(y),
    width: toSize(width),
    height: toSize(height),
  }))
}

function setText(canvas: SpatialCanvas, id: string, text: string): SpatialCanvas {
  return updateNode(canvas, id, (node) => (node.type === 'text' ? { ...node, text } : undefined))
}

function connectNodes(
  canvas: SpatialCanvas,
  edgeId: string,
  fromNode: string,
  toNode: string,
): SpatialCanvas {
  if (fromNode === toNode) return canvas
  const fromExists = canvas.nodes.some((node) => node.id === fromNode)
  const toExists = canvas.nodes.some((node) => node.id === toNode)
  if (!fromExists || !toExists) return canvas
  // spatialCanvasSchema rejects duplicate edges[].id, so a colliding
  // generated id must be rejected here too, or the resulting canvas would
  // fail validation downstream.
  const edgeIdExists = canvas.edges.some((edge) => edge.id === edgeId)
  if (edgeIdExists) return canvas
  const edge: CanvasEdge = { id: edgeId, fromNode, toNode }
  return { ...canvas, edges: [...canvas.edges, edge] }
}

/**
 * Appends `node`. Rejects a colliding id as a no-op — mirroring
 * `connectNodes`'s duplicate-edge-id guard — so a caller can never produce a
 * canvas that fails `spatialCanvasSchema`'s implicit unique-id expectation.
 */
function createNode(canvas: SpatialCanvas, node: SpatialNode): SpatialCanvas {
  const idExists = canvas.nodes.some((existing) => existing.id === node.id)
  if (idExists) return canvas
  return { ...canvas, nodes: [...canvas.nodes, node] }
}

/**
 * Removes the node with `id` plus every edge that references it as
 * `fromNode`/`toNode` — the command-layer half of the edge-referential-
 * integrity invariant `deleteSpatialNode` (workspace) also enforces
 * on the Loro side. A no-op (returns the input) when `id` is missing.
 */
function deleteNode(canvas: SpatialCanvas, id: string): SpatialCanvas {
  const idExists = canvas.nodes.some((node) => node.id === id)
  if (!idExists) return canvas
  return {
    ...canvas,
    nodes: canvas.nodes.filter((node) => node.id !== id),
    edges: canvas.edges.filter((edge) => edge.fromNode !== id && edge.toNode !== id),
  }
}

/** An empty label removes the field: the model's `label` is optional and an
 * empty string would serialize as an authored-but-blank label. */
/** Ends equal to the JSON Canvas defaults (fromEnd none, toEnd arrow) are
 * removed rather than written, keeping the stored document canonical. */
function setEdgeEnds(
  canvas: SpatialCanvas,
  id: string,
  fromEnd: 'none' | 'arrow',
  toEnd: 'none' | 'arrow',
): SpatialCanvas {
  if (!canvas.edges.some((edge) => edge.id === id)) return canvas
  return {
    ...canvas,
    edges: canvas.edges.map((edge) => {
      if (edge.id !== id) return edge
      const { fromEnd: _from, toEnd: _to, ...rest } = edge
      return {
        ...rest,
        ...(fromEnd === 'none' ? {} : { fromEnd }),
        ...(toEnd === 'arrow' ? {} : { toEnd }),
      }
    }),
  }
}

/** `color: undefined` removes the field — the theme default, canonically. */
/**
 * `straight` is the default, so choosing it REMOVES the setting rather than
 * recording it. A canvas that never chose a style and one that chose and
 * changed its mind then serialize identically — otherwise every canvas anyone
 * opened the menu on would carry a redundant extension forever.
 */
/**
 * Rebuilds the canvas envelope from the CANONICAL form of the visual.edges
 * facet: default values (routing straight, jumps none) are omitted, an
 * empty payload drops the facet key, an empty facets bucket disappears,
 * and an empty x-whiteboard disappears — so a canvas that chose a setting
 * and reverted serializes identically to one that never touched it.
 * Routing and jumps are independent fields of the same facet; writing one
 * must never erase the other.
 */
function withEdgeStyle(
  canvas: SpatialCanvas,
  patch: { routing?: EdgeRoutingStyle; lineJumps?: LineJumps },
): SpatialCanvas {
  const { 'x-whiteboard': extension, ...rest } = canvas
  // Seed the merge from the RESOLVED current value (facet first, legacy
  // fallback), so the first write on a legacy canvas carries its setting
  // into the facet — the write is where the migration persists.
  const current = resolveCanvasEdgeStyle(canvas)
  const merged = {
    routing: patch.routing ?? current.style,
    lineJumps: patch.lineJumps ?? current.lineJumps,
  }
  const canonical = {
    ...(merged.routing !== undefined && merged.routing !== 'straight'
      ? { routing: merged.routing }
      : {}),
    ...(merged.lineJumps !== undefined && merged.lineJumps !== 'none'
      ? { lineJumps: merged.lineJumps }
      : {}),
  }
  // The legacy edgeRouting key is absorbed above and removed here — one
  // facet, one version, no second place for the same answer to live.
  const { edgeRouting: _legacy, facets, ...others } = extension ?? {}
  const { [VISUAL_EDGES_KEY]: _previous, ...otherFacets } = facets ?? {}
  const nextFacets =
    Object.keys(canonical).length === 0
      ? otherFacets
      : { ...otherFacets, [VISUAL_EDGES_KEY]: canonical }
  const nextExtension = {
    ...others,
    ...(Object.keys(nextFacets).length === 0 ? {} : { facets: nextFacets }),
  }
  return Object.keys(nextExtension).length === 0 ? rest : { ...rest, 'x-whiteboard': nextExtension }
}

function setEdgeRouting(canvas: SpatialCanvas, style: EdgeRoutingStyle): SpatialCanvas {
  return withEdgeStyle(canvas, { routing: style })
}

function setLineJumps(canvas: SpatialCanvas, lineJumps: LineJumps): SpatialCanvas {
  return withEdgeStyle(canvas, { lineJumps })
}

/**
 * Same envelope discipline as the canvas-level facet write: the shape lives
 * as the visual.shape/v0 facet in the node's x-whiteboard facets bucket,
 * `undefined` (the historic rect) removes it, an empty bucket disappears,
 * and an empty extension disappears — while an embed extension and facets
 * this command does not own survive untouched.
 */
function setNodeFacet(
  canvas: SpatialCanvas,
  id: string,
  key: string,
  payload: unknown,
): SpatialCanvas {
  if (!canvas.nodes.some((node) => node.id === id)) return canvas
  return {
    ...canvas,
    nodes: canvas.nodes.map((node) => {
      if (node.id !== id) return node
      const { facets, ...extensionRest } = node['x-whiteboard'] ?? {}
      const { [key]: _previous, ...otherFacets } = facets ?? {}
      const nextFacets = payload === undefined ? otherFacets : { ...otherFacets, [key]: payload }
      const nextExtension = {
        ...extensionRest,
        ...(Object.keys(nextFacets).length === 0 ? {} : { facets: nextFacets }),
      }
      const { 'x-whiteboard': _extension, ...rest } = node
      return Object.keys(nextExtension).length === 0
        ? (rest as typeof node)
        : ({ ...rest, 'x-whiteboard': nextExtension } as typeof node)
    }),
  }
}

function setNodeColor(
  canvas: SpatialCanvas,
  id: string,
  color: CanvasColor | undefined,
): SpatialCanvas {
  if (!canvas.nodes.some((node) => node.id === id)) return canvas
  return {
    ...canvas,
    nodes: canvas.nodes.map((node) => {
      if (node.id !== id) return node
      const { color: _removed, ...rest } = node
      return color === undefined ? rest : { ...rest, color }
    }),
  }
}

function setNodeFile(canvas: SpatialCanvas, id: string, file: string): SpatialCanvas {
  if (!canvas.nodes.some((node) => node.id === id && node.type === 'file')) return canvas
  return {
    ...canvas,
    nodes: canvas.nodes.map((node) => {
      if (node.id !== id || node.type !== 'file') return node
      const { subpath: _removed, ...rest } = node
      return { ...rest, file }
    }),
  }
}

function createGroup(
  canvas: SpatialCanvas,
  node: Extract<SpatialNode, { type: 'group' }>,
): SpatialCanvas {
  if (canvas.nodes.some((existing) => existing.id === node.id)) return canvas
  return { ...canvas, nodes: [node, ...canvas.nodes] }
}

function setGroupLabel(canvas: SpatialCanvas, id: string, label: string): SpatialCanvas {
  if (!canvas.nodes.some((node) => node.id === id && node.type === 'group')) return canvas
  return {
    ...canvas,
    nodes: canvas.nodes.map((node) => {
      if (node.id !== id || node.type !== 'group') return node
      const { label: _removed, ...rest } = node
      return label === '' ? rest : { ...rest, label }
    }),
  }
}

function setGroupBackground(
  canvas: SpatialCanvas,
  id: string,
  background: string | undefined,
  backgroundStyle: 'cover' | 'ratio' | 'repeat' | undefined,
): SpatialCanvas {
  if (!canvas.nodes.some((node) => node.id === id && node.type === 'group')) return canvas
  return {
    ...canvas,
    nodes: canvas.nodes.map((node) => {
      if (node.id !== id || node.type !== 'group') return node
      const { background: _bg, backgroundStyle: _style, ...rest } = node
      if (background === undefined) return rest
      return {
        ...rest,
        background,
        ...(backgroundStyle !== undefined ? { backgroundStyle } : {}),
      }
    }),
  }
}

function setNodeUrl(canvas: SpatialCanvas, id: string, url: string): SpatialCanvas {
  if (!canvas.nodes.some((node) => node.id === id && node.type === 'link')) return canvas
  return {
    ...canvas,
    nodes: canvas.nodes.map((node) =>
      node.id === id && node.type === 'link' ? { ...node, url } : node,
    ),
  }
}

function setEdgeColor(
  canvas: SpatialCanvas,
  id: string,
  color: CanvasColor | undefined,
): SpatialCanvas {
  if (!canvas.edges.some((edge) => edge.id === id)) return canvas
  return {
    ...canvas,
    edges: canvas.edges.map((edge) => {
      if (edge.id !== id) return edge
      const { color: _removed, ...rest } = edge
      return color === undefined ? rest : { ...rest, color }
    }),
  }
}

/** `side: undefined` removes the pin so routing derives the side again. */
function setEdgeSide(
  canvas: SpatialCanvas,
  id: string,
  endpoint: 'from' | 'to',
  side: 'top' | 'right' | 'bottom' | 'left' | undefined,
): SpatialCanvas {
  if (!canvas.edges.some((edge) => edge.id === id)) return canvas
  const key = endpoint === 'from' ? 'fromSide' : 'toSide'
  return {
    ...canvas,
    edges: canvas.edges.map((edge) => {
      if (edge.id !== id) return edge
      const { [key]: _removed, ...rest } = edge
      return side === undefined ? rest : { ...rest, [key]: side }
    }),
  }
}

function setEdgeLabel(canvas: SpatialCanvas, id: string, label: string): SpatialCanvas {
  if (!canvas.edges.some((edge) => edge.id === id)) return canvas
  return {
    ...canvas,
    edges: canvas.edges.map((edge) => {
      if (edge.id !== id) return edge
      if (label === '') {
        const { label: _removed, ...rest } = edge
        return rest
      }
      return { ...edge, label }
    }),
  }
}

/**
 * Rewrites the canvas's `x-whiteboard.comments` array via `update`, which
 * receives the CURRENT comments (empty when none) and returns either the
 * next array or `undefined` to signal a no-op (matching every other
 * command's totality contract: a missing/colliding target id returns the
 * input canvas reference unchanged). Same envelope-canonicality discipline
 * as `withEdgeStyle`/`setNodeFacet`: an empty `comments` result drops the
 * key, an empty extension disappears entirely, and sibling extension fields
 * (edgeRouting, facets) survive untouched.
 */
function withComments(
  canvas: SpatialCanvas,
  update: (comments: readonly CanvasComment[]) => CanvasComment[] | undefined,
): SpatialCanvas {
  const { 'x-whiteboard': extension, ...rest } = canvas
  const nextComments = update(extension?.comments ?? [])
  if (nextComments === undefined) return canvas
  const { comments: _previous, ...otherExtension } = extension ?? {}
  const nextExtension = {
    ...otherExtension,
    ...(nextComments.length > 0 ? { comments: nextComments } : {}),
  }
  return Object.keys(nextExtension).length === 0 ? rest : { ...rest, 'x-whiteboard': nextExtension }
}

function createComment(canvas: SpatialCanvas, comment: CanvasComment): SpatialCanvas {
  return withComments(canvas, (comments) => {
    if (comments.some((existing) => existing.id === comment.id)) return undefined
    return [...comments, comment]
  })
}

/** One comment rewritten field-wise; a missing id leaves the canvas reference untouched. */
function patchComment(
  canvas: SpatialCanvas,
  id: string,
  patch: Partial<Pick<CanvasComment, 'resolved' | 'x' | 'y' | 'text'>>,
): SpatialCanvas {
  return withComments(canvas, (comments) => {
    if (!comments.some((comment) => comment.id === id)) return undefined
    return comments.map((comment) => (comment.id === id ? { ...comment, ...patch } : comment))
  })
}

function setCommentResolved(canvas: SpatialCanvas, id: string, resolved: boolean): SpatialCanvas {
  return patchComment(canvas, id, { resolved })
}

export function applyCommand(canvas: SpatialCanvas, command: EditorCommand): SpatialCanvas {
  switch (command.kind) {
    case 'move-node':
      return moveNode(canvas, command.id, command.x, command.y)
    case 'resize-node':
      return resizeNode(canvas, command.id, command.x, command.y, command.width, command.height)
    case 'set-text':
      return setText(canvas, command.id, command.text)
    case 'set-body':
    case 'set-facets':
      // Neither is IN the canvas — the body is the doc's own `body` text
      // container and the facets are its `core` map — so applying one leaves
      // the canvas value identical. Returning the same reference is what
      // keeps a keystroke in the markdown editor from re-rendering the
      // spatial scene.
      return canvas
    case 'connect-nodes':
      return connectNodes(canvas, command.edgeId, command.fromNode, command.toNode)
    case 'create-node':
      return createNode(canvas, command.node)
    case 'delete-edge':
      return { ...canvas, edges: canvas.edges.filter((edge) => edge.id !== command.id) }
    case 'set-edge-label':
      return setEdgeLabel(canvas, command.id, command.label)
    case 'set-edge-ends':
      return setEdgeEnds(canvas, command.id, command.fromEnd, command.toEnd)
    case 'set-edge-side':
      return setEdgeSide(canvas, command.id, command.endpoint, command.side)
    case 'set-node-color':
      return setNodeColor(canvas, command.id, command.color)
    case 'set-node-facet':
      return setNodeFacet(canvas, command.id, command.key, command.payload)
    case 'set-edge-routing':
      return setEdgeRouting(canvas, command.style)
    case 'set-line-jumps':
      return setLineJumps(canvas, command.lineJumps)
    case 'set-edge-color':
      return setEdgeColor(canvas, command.id, command.color)
    case 'set-node-url':
      return setNodeUrl(canvas, command.id, command.url)
    case 'set-node-file':
      return setNodeFile(canvas, command.id, command.file)
    case 'create-group':
      return createGroup(canvas, command.node)
    case 'set-group-label':
      return setGroupLabel(canvas, command.id, command.label)
    case 'set-group-background':
      return setGroupBackground(canvas, command.id, command.background, command.backgroundStyle)
    case 'delete-node':
      return deleteNode(canvas, command.id)
    case 'reorder-nodes':
      return reorderNodes(canvas, command.ids, command.placement)
    case 'create-edge':
      return createEdge(canvas, command.edge)
    case 'create-comment':
      return createComment(canvas, command.comment)
    case 'set-comment-resolved':
      return setCommentResolved(canvas, command.id, command.resolved)
    case 'move-comment':
      return patchComment(canvas, command.id, { x: command.x, y: command.y })
    case 'set-comment-text':
      return patchComment(canvas, command.id, { text: command.text })
    case 'create-thread': {
      const projected = canvasCommentFromThread(command.thread, (id) =>
        canvas.nodes.find((node) => node.id === id),
      )
      return projected === undefined ? canvas : createComment(canvas, projected)
    }
    case 'reply-to-thread':
      // Identity, and deliberately: the conversation is a plane beside the
      // canvas, so a reply has no canvas effect to compute. Returning the same reference keeps the union-wide
      // "nothing changed → same object" contract that callers memoise on.
      return canvas
    case 'batch':
      // Pure fold; a batch of no-ops folds back to the input reference,
      // preserving the union-wide "nothing changed → same object" contract.
      return command.commands.reduce(applyCommand, canvas)
  }
}

function createEdge(canvas: SpatialCanvas, edge: CanvasEdge): SpatialCanvas {
  if (canvas.edges.some((existing) => existing.id === edge.id)) return canvas
  if (edge.fromNode === edge.toNode) return canvas
  const nodeIds = new Set(canvas.nodes.map((node) => node.id))
  if (!nodeIds.has(edge.fromNode) || !nodeIds.has(edge.toNode)) return canvas
  return { ...canvas, edges: [...canvas.edges, edge] }
}

/** Strict bbox intersection — flush-touching edges are NOT overlap. */
function overlapsAny(
  candidate: SpatialCanvas['nodes'][number],
  block: readonly SpatialCanvas['nodes'][number][],
): boolean {
  return block.some(
    (member) =>
      candidate.x < member.x + member.width &&
      member.x < candidate.x + candidate.width &&
      candidate.y < member.y + member.height &&
      member.y < candidate.y + candidate.height,
  )
}

function reorderNodes(
  canvas: SpatialCanvas,
  ids: readonly string[],
  placement: 'forward' | 'backward' | 'front' | 'back',
): SpatialCanvas {
  const members = new Set(ids)
  const block = canvas.nodes.filter((node) => members.has(node.id))
  if (block.length === 0) return canvas
  const rest = canvas.nodes.filter((node) => !members.has(node.id))

  let insertAt: number
  switch (placement) {
    case 'front':
      insertAt = rest.length
      break
    case 'back':
      insertAt = 0
      break
    case 'forward': {
      // Step the block over the nearest OVERLAPPING non-member above its
      // topmost member (tldraw semantics, user feedback 2026-08-09):
      // hopping over a node the selection does not visually overlap
      // changes nothing on screen and reads as the shortcut "not working".
      // No overlapping node above → the block is already visually on top
      // of its pile → no-op. (Index loops, not findLast/findLastIndex —
      // the tsconfig lib target predates es2023.)
      let top = -1
      for (let i = canvas.nodes.length - 1; i >= 0; i--) {
        if (members.has(canvas.nodes[i].id)) {
          top = i
          break
        }
      }
      const over = canvas.nodes
        .slice(top + 1)
        .find((node) => !members.has(node.id) && overlapsAny(node, block))
      if (over === undefined) return canvas
      insertAt = rest.indexOf(over) + 1
      break
    }
    case 'backward': {
      // Mirror: step under the nearest overlapping non-member below the
      // bottom member.
      const bottom = canvas.nodes.findIndex((node) => members.has(node.id))
      let under: SpatialCanvas['nodes'][number] | undefined
      for (let i = bottom - 1; i >= 0; i--) {
        const node = canvas.nodes[i]
        if (!members.has(node.id) && overlapsAny(node, block)) {
          under = node
          break
        }
      }
      if (under === undefined) return canvas
      insertAt = rest.indexOf(under)
      break
    }
  }

  const next = [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)]
  // No-op permutations return the input so callers can cheaply detect "did
  // anything move" (and undo history stays free of empty steps).
  if (next.every((node, index) => node === canvas.nodes[index])) return canvas
  return { ...canvas, nodes: next }
}

/** Standard duplicate-again cascade offset — also `pasteFragment`'s
 * fallback when it is given no anchor point. */
export const DUPLICATE_OFFSET_PX = 16

/**
 * The shared core of `pasteFragment` and `duplicateSelection`: remint a
 * fragment's ids against `canvas`'s existing ones, then batch it in as
 * `create-node`/`create-edge`, offset either by the standard +16/+16
 * duplicate cascade (no anchor) or so its bounding-box center lands on
 * `anchor` (rounded) — the "Paste here" placement. Undefined for an
 * empty-node fragment, matching every other command builder's totality
 * contract: nothing to insert is nothing to command.
 */
export function buildFragmentInsertCommand(
  canvas: SpatialCanvas,
  fragment: Pick<ClipboardFragment, 'nodes' | 'edges' | 'cut'>,
  createId: () => string,
  anchor?: Point,
): EditorCommand | undefined {
  if (fragment.nodes.length === 0) return undefined
  const existingIds = new Set([
    ...canvas.nodes.map((node) => node.id),
    ...canvas.edges.map((edge) => edge.id),
  ])
  const reminted = remintClipboardFragment(fragment, createId, existingIds)
  let dx = DUPLICATE_OFFSET_PX
  let dy = DUPLICATE_OFFSET_PX
  if (anchor !== undefined) {
    const minX = Math.min(...reminted.nodes.map((node) => node.x))
    const minY = Math.min(...reminted.nodes.map((node) => node.y))
    const maxX = Math.max(...reminted.nodes.map((node) => node.x + node.width))
    const maxY = Math.max(...reminted.nodes.map((node) => node.y + node.height))
    dx = Math.round(anchor.x - (minX + maxX) / 2)
    dy = Math.round(anchor.y - (minY + maxY) / 2)
  }
  // A cut fragment reconnects its severed boundary edges to peers that
  // still exist on THIS canvas (same-canvas paste is a move); a missing
  // peer means a cross-canvas paste or a deleted neighbour, and the edge
  // drops silently — exactly what a plain copy would have done.
  const canvasNodeIds = new Set(canvas.nodes.map((node) => node.id))
  const canvasEdgeIds = new Set(canvas.edges.map((edge) => edge.id))
  const boundaryEdges = (fragment.cut?.boundaryEdges ?? []).flatMap((edge) => {
    // The original edge still exists → it was never actually severed (the
    // cut was lifted, or resolved as a move): nothing to reconnect, and a
    // second wire onto the peer would be the new defect.
    if (canvasEdgeIds.has(edge.id)) return []
    const from = reminted.idMap.get(edge.fromNode)
    const to = reminted.idMap.get(edge.toNode)
    if ((from === undefined) === (to === undefined)) return []
    const peer = from === undefined ? edge.fromNode : edge.toNode
    if (!canvasNodeIds.has(peer)) return []
    return [
      {
        ...edge,
        id: reminted.mintId(),
        fromNode: from ?? edge.fromNode,
        toNode: to ?? edge.toNode,
      },
    ]
  })
  return {
    kind: 'batch',
    commands: [
      ...reminted.nodes.map(
        (node) =>
          ({ kind: 'create-node', node: { ...node, x: node.x + dx, y: node.y + dy } }) as const,
      ),
      ...[...reminted.edges, ...boundaryEdges].map(
        (edge) => ({ kind: 'create-edge', edge }) as const,
      ),
    ],
  }
}
