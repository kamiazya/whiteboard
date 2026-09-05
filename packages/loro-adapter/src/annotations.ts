/**
 * Reading the annotation layer, for any document kind.
 *
 * The layer is stored one level above content (ADR-0026 decision 1) — a
 * document-level `threads` map, a peer of `nodes`, `edges` and `body` rather
 * than something inside the canvas envelope. This is the reader that says so:
 * it takes a document's containers and answers its conversations, and it
 * never mentions a canvas.
 *
 * Before it existed the union below sat inside `readSpatialCanvas`, which
 * made a markdown document's threads *unreachable* rather than absent —
 * stored correctly and readable by nothing.
 */

import type { CommentTargetNode, CommentThread } from '@kamiazya/whiteboard-model'
import {
  type CanvasComment,
  canvasCommentFromThread,
  canvasCommentSchema,
  threadFromCanvasComment,
} from '@kamiazya/whiteboard-model'
import { readCommentThreads } from './comment-threads.js'
import { COMMENTS_KEY, type DocumentContainers } from './containers.js'

/**
 * Every conversation on this document: the threads plane, plus any legacy
 * comment no writer has migrated yet, lifted into the one-message thread it
 * always was.
 *
 * **Threads come first, and the legacy rows keep their map order after them.**
 * That is not presentation: `composeComments` fans a later bubble out around
 * an earlier one, so the sequence decides where a comment is drawn. Sorting
 * the union by id would read more tidily and would move bubbles on any
 * document that still holds both shapes.
 *
 * A read never migrates. Doing so would turn opening a document into a
 * commit, and a reader may not even hold the write lock — the first WRITE
 * empties the legacy map instead.
 *
 * A record the schema rejects costs that record and nothing beside it, the
 * contract every reader in this package keeps.
 */
export function readAnnotations(doc: DocumentContainers): CommentThread[] {
  const threads = readCommentThreads(doc)
  const known = new Set(threads.map((thread) => thread.id))
  const legacy: CommentThread[] = []
  const commentsMap = doc.getMap(COMMENTS_KEY)
  for (const commentId of commentsMap.keys()) {
    // A replica that merged an old peer's write can hold both shapes for one
    // id. The thread is the newer one, and the one a reply was written into.
    if (known.has(commentId)) continue
    const parsed = canvasCommentSchema.safeParse(commentsMap.get(commentId))
    if (parsed.success) legacy.push(threadFromCanvasComment(parsed.data))
  }
  return [...threads, ...legacy]
}

/**
 * The same layer as the flat comments the canvas renderer still takes.
 *
 * Lossy by construction — a thread's replies have nowhere to go in a shape
 * that holds one `text` — which is why it is a projection with a name rather
 * than something a caller does inline. It goes when the renderer takes
 * threads (ADR-0026 step 3).
 */
export function readCanvasComments(
  doc: DocumentContainers,
  nodeById?: (id: string) => CommentTargetNode | undefined,
): CanvasComment[] {
  const comments: CanvasComment[] = []
  for (const thread of readAnnotations(doc)) {
    const projected = canvasCommentFromThread(thread, nodeById)
    if (projected !== undefined) comments.push(projected)
  }
  return comments
}
