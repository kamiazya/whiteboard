/**
 * A flat `CanvasComment` written as the thread it projects from.
 *
 * The canvas API every consumer speaks still takes the flat shape, while a
 * comment lives in the threads plane (ADR-0026). Every canvas write of a
 * comment comes through here — `loro-bridge`'s single-commit, resync and batch
 * paths alike — so they cannot drift apart on how one becomes a thread.
 */

import {
  type AnnotationAnchor,
  type CanvasComment,
  threadFromCanvasComment,
} from '@kamiazya/whiteboard-model'
import {
  migrateCanvasCommentsToThreads,
  readCommentThread,
  writeThreadInto,
} from './comment-threads.js'
import { type DocumentContainers, THREADS_KEY } from './containers.js'

function assertWritableComment(comment: CanvasComment): void {
  // Same loud refusal as loro-bridge's nodeToFields: readSpatialCanvas
  // round-trips every comment through the Zod schema and silently drops
  // failures, so a NaN anchor written here would delete the comment for
  // every reader.
  for (const [field, value] of [
    ['x', comment.x],
    ['y', comment.y],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `canvas comment "${comment.id}" has a non-finite ${field} (${value}); the anchor must be finite`,
      )
    }
  }
  // The same class of loss one field over: the thread this comment becomes
  // carries both references on one spatial anchor, which the anchor schema
  // refuses, so a reader would drop the comment for everyone.
  if (comment.targetNodeId !== undefined && comment.targetEdgeId !== undefined) {
    throw new TypeError(
      `canvas comment "${comment.id}" names both a node and an edge; a comment is about one of them`,
    )
  }
}

/** Whether `canvasCommentFromThread` carries this anchor without loss: a point, a node, an edge. */
function flatCanCarry(anchor: AnnotationAnchor): boolean {
  return anchor.kind === 'spatial' && anchor.nodeIds === undefined && anchor.width === undefined
}

/** Writes one flat canvas comment into the threads plane, without a commit. */
export function writeCommentInto(doc: DocumentContainers, comment: CanvasComment): void {
  // Refuses a non-finite anchor loudly and before anything is stored — a
  // thread whose anchor fails the schema would be dropped by every reader.
  assertWritableComment(comment)
  migrateCanvasCommentsToThreads(doc)
  const incoming = threadFromCanvasComment(comment)
  const held = readCommentThread(doc, comment.id)
  if (held === undefined) {
    writeThreadInto(doc, incoming)
    return
  }
  // A flat comment is a PROJECTION of its thread, and writing a projection
  // back verbatim loses what it could not carry. Two things it cannot:
  // - an anchor beyond a point, a node or an edge. A thread on a node's
  //   text projects as a comment on that node, a node set or a region as a
  //   comment at its corner, and written back each would become that
  //   point. The text and the status are what a flat write can honestly
  //   change; the anchor it saw is the one it keeps.
  // - the opening message's identity. The projection borrows the thread's
  //   id for its one message, which is right for a comment the canvas
  //   opened and wrong for one an MCP peer opened with a message id of its
  //   own: written under the thread's id, an edit ADDED a message and
  //   sorted it ahead of the original, which then read as a reply.
  const opening = held.messages[0]
  const edited = incoming.messages[0]
  if (opening === undefined || edited === undefined) {
    writeThreadInto(doc, incoming)
    return
  }
  writeThreadInto(doc, {
    ...incoming,
    anchor: flatCanCarry(held.anchor) ? incoming.anchor : held.anchor,
    messages: [
      {
        ...edited,
        id: opening.id,
        ...(opening.createdAt === undefined ? {} : { createdAt: opening.createdAt }),
        ...(opening.author === undefined ? {} : { author: opening.author }),
      },
    ],
  })
}

/** Returns false (writing nothing) when the comment id is absent. */
export function deleteCommentInto(doc: DocumentContainers, commentId: string): boolean {
  // The legacy entry goes too, or the readers' legacy fallback would
  // resurrect a comment this call closed.
  migrateCanvasCommentsToThreads(doc)
  const threadsMap = doc.getMap(THREADS_KEY)
  if (threadsMap.get(commentId) === undefined) return false
  threadsMap.delete(commentId)
  return true
}
