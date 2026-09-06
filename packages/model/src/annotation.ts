import { z } from 'zod'
import { nodeIdSchema } from './ids.js'
import type { CanvasComment } from './spatial.js'
import { okfActorSchema, okfTimestampSchema } from './trust.js'

/**
 * The annotation layer's identifiers (ADR-0026). Same deliberate looseness as
 * `nodeIdSchema` and for the same reason — they are nanoid-style strings and
 * the alphabet may be swapped — but a separate schema, because a thread is not
 * a node and the two must be free to diverge.
 */
export const annotationIdSchema = z.string().min(1, 'annotation id must not be empty')

/**
 * A quote-based text selector, after the W3C Web Annotation Data Model's
 * `TextQuoteSelector`: the exact string the annotation is about, plus enough
 * surrounding context to disambiguate a repeated phrase.
 *
 * `prefix`/`suffix` are optional because a producer may have none to give (an
 * anchor at the very start or end of a body); `exact` is not, because it is
 * the only part that can re-find the passage after an edit.
 */
export const textQuoteSelectorSchema = z
  .object({
    prefix: z.string().optional(),
    exact: z.string().min(1, 'a text anchor must quote at least one character'),
    suffix: z.string().optional(),
  })
  .strict()

export type TextQuoteSelector = z.infer<typeof textQuoteSelectorSchema>

/**
 * A passage of prose: the `text` arm of the anchor union, named because a
 * second layer anchors to one. A proposal on a markdown note is a
 * REPLACEMENT PASSAGE (ADR-0029 decision 6), and it points at its passage
 * the same way a comment does — which is the point of naming this rather
 * than restating it: the resolution order ADR-0026 established (mark →
 * unique quote → quote with context → orphaned) is the mechanism, and a
 * second selector shape would need a second one.
 */
export const textAnchorSchema = z
  .object({
    kind: z.literal('text'),
    /** The text node whose text the passage is in; absent, the document's own body. */
    nodeId: nodeIdSchema.optional(),
    quote: textQuoteSelectorSchema,
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .strict()
  .refine((anchor) => anchor.end >= anchor.start, {
    message: 'a text anchor must not end before it starts',
  })

export type TextAnchor = z.infer<typeof textAnchorSchema>

/**
 * Where an annotation points. This is the ONLY part of the layer that varies
 * by document kind, which is what lets one thread shape serve the spatial
 * canvas, the markdown body, and whatever format comes next.
 *
 * Every arm has the same shape: an OPTIONAL object reference plus a positional
 * fallback. The reference is what survives the object moving; the position is
 * what survives the object being deleted, and is what an orphaned annotation
 * is still drawn from.
 *
 * The arm is the SURFACE, and the reference names an object on it — which
 * is why the spatial arm may name a node or an edge (an edge is as much an
 * object of the canvas as a node is, and a reader has as much to say about
 * a connection as about what it connects), and why the text arm may name
 * the node whose text it is about: a passage inside a text node lives on
 * the canvas, but its position is a place in a string, not a point. The
 * places a reader wants to comment on, and the arm that carries each:
 *
 * | place                              | arm        | reference | fallback        |
 * |------------------------------------|------------|-----------|-----------------|
 * | a spot on the canvas               | `spatial`  | —         | the point       |
 * | a node (text, file, link, group)   | `spatial`  | `nodeId`  | the point       |
 * | an edge                            | `spatial`  | `edgeId`  | the point       |
 * | several nodes at once (a selection)| `spatial`  | `nodeIds` | the rect        |
 * | a region of the canvas             | `spatial`  | —         | the rect        |
 * | a passage of a note's body         | `text`     | —         | quote + offsets |
 * | a passage of a text node's text    | `text`     | `nodeId`  | quote + offsets |
 * | the document as a whole            | `document` | —         | —               |
 *
 * A region is the spatial arm with a `width` and `height`: the rect is the
 * position, the way the point is for the other spatial anchors, and a node
 * set stores the rect its nodes occupied as the place an orphan is drawn
 * from. The `document` arm is the one anchor with no position at all —
 * the container is not on any surface, so nothing draws it in place and
 * the panel is where it is read (ADR-0026 decision 5).
 *
 * The union is closed on purpose — a new format is a new arm here, so every
 * renderer's switch over it stays exhaustive rather than silently ignoring a
 * kind it has never seen. A new object on an existing surface is a new
 * reference on that surface's arm, never a new arm.
 */
export const annotationAnchorSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('spatial'),
      nodeId: nodeIdSchema.optional(),
      edgeId: nodeIdSchema.optional(),
      /** Several nodes the conversation is about at once — a selection, not a single object. */
      nodeIds: z.array(nodeIdSchema).min(2, 'a node set names at least two nodes').optional(),
      // Integer, matching JSON Canvas geometry and `canvasCommentSchema`: a
      // fractional anchor taken from a zoomed viewport survives the session
      // and then vanishes, because the next read drops what fails the schema.
      x: z.number().int(),
      y: z.number().int(),
      /** With `height`: the anchor is a REGION with `x`/`y` its top-left corner. */
      width: z.number().int().nonnegative().optional(),
      height: z.number().int().nonnegative().optional(),
    })
    .strict()
    .refine(
      (anchor) =>
        [anchor.nodeId, anchor.edgeId, anchor.nodeIds].filter((ref) => ref !== undefined).length <=
        1,
      { message: 'a spatial anchor names a node, an edge or a node set, not two of them' },
    )
    .refine(
      (anchor) =>
        anchor.nodeIds === undefined || new Set(anchor.nodeIds).size === anchor.nodeIds.length,
      {
        message: 'a node set names each node once',
      },
    )
    .refine((anchor) => (anchor.width === undefined) === (anchor.height === undefined), {
      message: 'a region has both a width and a height',
    }),
  textAnchorSchema,
  z.object({ kind: z.literal('document') }).strict(),
])

export type AnnotationAnchor = z.infer<typeof annotationAnchorSchema>
export type SpatialAnchor = Extract<AnnotationAnchor, { kind: 'spatial' }>

/** An axis-aligned rectangle in canvas coordinates. */
export interface AnchorRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The rectangle a spatial anchor stands for, if it stands for one: the
 * bounds of whichever of its nodes still exist, else the rect it stored.
 * `undefined` for a point, node or edge anchor, which stand for no area.
 *
 * Live nodes first, because the reference is what survives the objects
 * moving — a selection commented on and then dragged apart is still about
 * those nodes, and the outline follows them. The stored rect is what an
 * orphaned set is drawn from once every node is gone, the same role the
 * point plays for a deleted node's comment.
 */
export function spatialAnchorRect(
  anchor: SpatialAnchor,
  nodeById?: (id: string) => CommentTargetNode | undefined,
): AnchorRect | undefined {
  if (anchor.nodeIds !== undefined) {
    const live = anchor.nodeIds.flatMap((id) => {
      const node = nodeById?.(id)
      return node === undefined ? [] : [node]
    })
    if (live.length > 0) {
      const left = Math.min(...live.map((node) => node.x))
      const top = Math.min(...live.map((node) => node.y))
      const right = Math.max(...live.map((node) => node.x + node.width))
      const bottom = Math.max(...live.map((node) => node.y + node.height))
      return { x: left, y: top, width: right - left, height: bottom - top }
    }
  }
  if (anchor.width === undefined || anchor.height === undefined) return undefined
  return { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height }
}

/**
 * One message in a thread. Deliberately carries NEITHER an anchor nor a
 * resolution flag: a reply inherits the thread's anchor, and it is the
 * conversation that gets closed, not an individual remark. With `resolved` on
 * a message and replies beside it, "which one's flag counts?" has no
 * defensible answer.
 *
 * `author` and `createdAt` are optional because identity and time are keeper
 * concerns — a browser-kept workspace has no signed-in author to record.
 */
export const commentMessageSchema = z
  .object({
    id: annotationIdSchema,
    body: z.string().min(1, 'a comment message must not be empty'),
    author: okfActorSchema.optional(),
    createdAt: okfTimestampSchema.optional(),
    editedAt: okfTimestampSchema.optional(),
  })
  .strict()

export type CommentMessage = z.infer<typeof commentMessageSchema>

export const commentThreadStatusSchema = z.enum(['open', 'resolved'])

export type CommentThreadStatus = z.infer<typeof commentThreadStatusSchema>

/**
 * The anchored unit of the annotation layer: one thread, holding where it
 * points, whether it is still open, and the messages that make up the
 * conversation. At least one message, because a thread with none is an anchor
 * nobody can read and nothing would ever draw.
 */
export const commentThreadSchema = z
  .object({
    id: annotationIdSchema,
    anchor: annotationAnchorSchema,
    status: commentThreadStatusSchema,
    createdAt: okfTimestampSchema.optional(),
    messages: z.array(commentMessageSchema).min(1, 'a thread has at least one message'),
  })
  .strict()

export type CommentThread = z.infer<typeof commentThreadSchema>

/**
 * The one order two peers reading the same thread agree on. `createdAt` first,
 * then id as the tie-break — left to sort stability, two peers that received
 * the same two messages in different orders would render them differently.
 *
 * A message with no timestamp sorts earliest, which keeps the comparator total
 * rather than leaving an undefined pair to compare as `NaN`.
 */
export function compareMessages(a: CommentMessage, b: CommentMessage): number {
  const at = a.createdAt ?? ''
  const bt = b.createdAt ?? ''
  if (at !== bt) return at < bt ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

/**
 * Today's flat canvas comment, read as the one-message thread it always was.
 *
 * The THREAD keeps the comment's id: that id is what every existing anchor,
 * MCP call and test already names. The single message borrows it, so a
 * migrated record introduces no identifier nobody has seen before.
 */
export function threadFromCanvasComment(comment: CanvasComment): CommentThread {
  const anchor: AnnotationAnchor = {
    kind: 'spatial',
    ...(comment.targetNodeId === undefined ? {} : { nodeId: comment.targetNodeId }),
    ...(comment.targetEdgeId === undefined ? {} : { edgeId: comment.targetEdgeId }),
    x: comment.x,
    y: comment.y,
  }
  return {
    id: comment.id,
    anchor,
    status: comment.resolved === true ? 'resolved' : 'open',
    ...(comment.createdAt === undefined ? {} : { createdAt: comment.createdAt }),
    messages: [
      {
        id: comment.id,
        body: comment.text,
        ...(comment.createdAt === undefined ? {} : { createdAt: comment.createdAt }),
        ...(comment.author === undefined ? {} : { author: comment.author }),
      },
    ],
  }
}

/** What the projection needs to know about a node: the box it occupies. */
export interface CommentTargetNode {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * One thread as the canvas still sees it: a single comment at a spatial
 * anchor. Lossy by construction — a thread's replies have nowhere to go in a
 * `CanvasComment`, and a passage has no canvas position of its own — which
 * is why this is a PROJECTION rather than the shape anything stores. The
 * panel that shows a conversation reads threads directly.
 *
 * Every arm projects, or says why not:
 * - `spatial` → the comment as it always was, its node or edge reference
 *   carried as `targetNodeId` / `targetEdgeId`. A node set or a region has
 *   no single object to carry, so it projects as a comment at the
 *   top-right corner of the rect it stands for (`spatialAnchorRect`) —
 *   the corner a node comment stands at, for the box the set occupies.
 * - `document` → nothing: there is no place on the canvas for a comment
 *   about the container, and the panel reads the thread directly.
 * - `text` naming a node → a node comment at that node's top-right corner,
 *   found through `nodeById`; the renderer follows the node from there. The
 *   node gone, there is no corner to stand at: `undefined`, which is the
 *   orphaned state (ADR-0026 decision 4) and the panel's to show.
 * - `text` naming no node → a note's passage, which the canvas cannot draw:
 *   `undefined`.
 *
 * `nodeById` is optional so a caller that has no canvas (a reader of the
 * threads plane alone) still projects every spatial thread; it then answers
 * `undefined` for a node passage, the same as for a node that is gone.
 */
export function canvasCommentFromThread(
  thread: CommentThread,
  nodeById?: (id: string) => CommentTargetNode | undefined,
): CanvasComment | undefined {
  // Messages arrive sorted by `compareMessages`, so this is the message the
  // conversation opened with rather than whichever arrived first.
  const opening = thread.messages[0]
  if (opening === undefined) return undefined
  const { anchor } = thread
  let place: {
    readonly x: number
    readonly y: number
    readonly targetNodeId?: string
    readonly targetEdgeId?: string
  }
  if (anchor.kind === 'document') return undefined
  if (anchor.kind === 'spatial') {
    const rect = spatialAnchorRect(anchor, nodeById)
    place =
      rect !== undefined
        ? { x: rect.x + rect.width, y: rect.y }
        : {
            x: anchor.x,
            y: anchor.y,
            ...(anchor.nodeId === undefined ? {} : { targetNodeId: anchor.nodeId }),
            ...(anchor.edgeId === undefined ? {} : { targetEdgeId: anchor.edgeId }),
          }
  } else {
    if (anchor.nodeId === undefined) return undefined
    const node = nodeById?.(anchor.nodeId)
    if (node === undefined) return undefined
    place = { x: node.x + node.width, y: node.y, targetNodeId: node.id }
  }
  return {
    id: thread.id,
    ...place,
    text: opening.body,
    ...(opening.author === undefined ? {} : { author: opening.author }),
    ...(opening.createdAt === undefined ? {} : { createdAt: opening.createdAt }),
    // Only the closed state is spelled out: `resolved: false` and no field
    // are the same state under `canvasCommentSchema`, and emitting one of
    // them keeps a reader from treating the other as unknown.
    ...(thread.status === 'resolved' ? { resolved: true } : {}),
  }
}

/** The surfaces the anchor union carries — one per arm, read off the schema so a new arm cannot be missed. */
export const ANNOTATION_ANCHOR_KINDS: readonly AnnotationAnchor['kind'][] =
  annotationAnchorSchema.options.map((option) => option.shape.kind.value)
