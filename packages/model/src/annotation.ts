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
 * Where an annotation points. This is the ONLY part of the layer that varies
 * by document kind, which is what lets one thread shape serve the spatial
 * canvas, the markdown body, and whatever format comes next.
 *
 * Every arm has the same shape: an OPTIONAL object reference plus a positional
 * fallback. The reference is what survives the object moving; the position is
 * what survives the object being deleted, and is what an orphaned annotation
 * is still drawn from.
 *
 * The union is closed on purpose — a new format is a new arm here, so every
 * renderer's switch over it stays exhaustive rather than silently ignoring a
 * kind it has never seen.
 */
export const annotationAnchorSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('spatial'),
      nodeId: nodeIdSchema.optional(),
      // Integer, matching JSON Canvas geometry and `canvasCommentSchema`: a
      // fractional anchor taken from a zoomed viewport survives the session
      // and then vanishes, because the next read drops what fails the schema.
      x: z.number().int(),
      y: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('text'),
      quote: textQuoteSelectorSchema,
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    })
    .strict()
    .refine((anchor) => anchor.end >= anchor.start, {
      message: 'a text anchor must not end before it starts',
    }),
])

export type AnnotationAnchor = z.infer<typeof annotationAnchorSchema>

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
