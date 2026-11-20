import type { PassageRange } from '@kamiazya/whiteboard-loro-adapter'
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { getAppLogger } from './app-logger.js'
import type { SessionDocument } from './session-document.js'
import { missingThreadMarks } from './text-anchor.js'

const log = getAppLogger('document-sync')

/**
 * One identity for "this document has no marks", so a publish that found
 * none does not hand every subscriber a fresh map to diff against.
 */
export const NO_THREAD_MARKS: ReadonlyMap<string, PassageRange> = new Map()

/**
 * Where each conversation's passage is now, and — once per body — the
 * marks a document arrived without.
 *
 * Marks do not travel through a markdown file, and a thread an MCP peer
 * wrote never had one, so the quote is asked ONCE at the moment the body
 * is known and its answer written down for the CRDT to carry. Once,
 * because the answer is wanted on every external update: re-asking would pay a body
 * search per update for every thread whose passage is genuinely gone, and
 * would keep re-deriving nothing.
 *
 * Guarded, and the read is what matters: a body the backfill cannot write
 * to must still publish the marks it already has, rather than costing the
 * whole annotation channel its value.
 *
 * The document is compared by identity rather than a boolean: a reconnect
 * opens a fresh one, and a boolean would leave the second un-backfilled forever.
 */
export function createThreadMarksRefresher(): (
  targetDoc: SessionDocument,
  threads: readonly CommentThread[],
) => ReadonlyMap<string, PassageRange> {
  let backfilledFor: SessionDocument | null = null
  return (targetDoc, threads) => {
    let marks: ReadonlyMap<string, PassageRange>
    try {
      marks = targetDoc.threadMarks()
    } catch (err) {
      log.warn('reading thread marks failed', err)
      return NO_THREAD_MARKS
    }
    if (backfilledFor === targetDoc) return marks
    backfilledFor = targetDoc
    try {
      const missing = missingThreadMarks(targetDoc.markdownBody(), threads, marks)
      if (missing.size === 0) return marks
      targetDoc.markThreadPassages(missing)
      return targetDoc.threadMarks()
    } catch (err) {
      log.warn('backfilling thread marks failed', err)
      return marks
    }
  }
}
