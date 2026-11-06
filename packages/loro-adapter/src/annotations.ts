/**
 * Reading the annotation layer, for any document kind.
 *
 * The layer is stored one level above content (ADR-0026 decision 1) — a
 * document-level `threads` map, a peer of `nodes`, `edges` and `body` rather
 * than something inside the canvas envelope. This is the reader that says so:
 * it takes a document's containers and answers its conversations, and it
 * never mentions a canvas.
 */

import type { CommentThread } from '@kamiazya/whiteboard-model'
import { readCommentThreads } from './comment-threads.js'
import { type DocumentContainers, RETIRED_COMMENTS_KEY } from './containers.js'

/**
 * A document that still holds comments in the plane before threads
 * (ADR-0024's flat `comments` map), which this version no longer reads.
 *
 * Refused rather than read as empty (owner decision 27): with no reader left
 * for the old shape, answering "no conversations" would lose every one of
 * them with no word said. The bytes stay where they are; the caller says so.
 */
export class RetiredCommentPlaneError extends Error {
  readonly code = 'retired_comment_plane'

  constructor(readonly rows: number) {
    super(
      `this document holds ${rows} comment${rows === 1 ? '' : 's'} saved by an older version in a form this version no longer reads (the flat comments plane before threads); its data has not been changed`,
    )
    this.name = 'RetiredCommentPlaneError'
  }
}

/** How many rows the retired plane holds, opening nothing to find out. */
function retiredRows(doc: DocumentContainers): number {
  // A tree node opens a container by WRITING it, which a read must not do;
  // a document root is free to look at, since roots are implicit.
  const plane =
    doc.peekMap === undefined ? doc.getMap(RETIRED_COMMENTS_KEY) : doc.peekMap(RETIRED_COMMENTS_KEY)
  return plane?.size ?? 0
}

/** Whether this document holds comments only the retired plane carries. */
export function holdsRetiredCommentPlane(doc: DocumentContainers): boolean {
  return retiredRows(doc) > 0
}

/**
 * Every conversation on this document, in the threads plane's order (by id).
 * Throws `RetiredCommentPlaneError` for a document the old plane still holds
 * comments for.
 *
 * A record the schema rejects costs that record and nothing beside it, the
 * contract every reader in this package keeps.
 */
export function readAnnotations(doc: DocumentContainers): CommentThread[] {
  const rows = retiredRows(doc)
  if (rows > 0) throw new RetiredCommentPlaneError(rows)
  return readCommentThreads(doc)
}
