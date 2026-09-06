/**
 * The THREAD-shaped half of text anchoring: what the rail asks of a body, and
 * what a document owes the marks it has not derived yet.
 *
 * The resolver itself is `@kamiazya/whiteboard-model`'s `resolveTextAnchor` —
 * it moved to the shared layer when a second reader appeared for it (a
 * proposed replacement passage deciding where it applies, ADR-0029 decision
 * 6). Re-exported here so this module still reads as one subject to its
 * callers, and so the two answers cannot drift apart.
 */

import type { AnnotationAnchor, LivePassage } from '@kamiazya/whiteboard-model'
import { resolveTextAnchor } from '@kamiazya/whiteboard-model'

export type { LivePassage, ResolvedTextAnchor, TextAnchor } from '@kamiazya/whiteboard-model'
export { resolveTextAnchor } from '@kamiazya/whiteboard-model'

/**
 * Whether each of a document's threads still finds its place, for the rail's
 * `resolveAnchor`.
 *
 * One function so the two keeper pages cannot answer this differently — the
 * gap that let the rail exist on one page and not the other was exactly this
 * shape, a decision made twice.
 *
 * `body` null means the document's text has not loaded yet, which is NOT the
 * same as a passage being gone: answering `orphaned` there would mark every
 * thread as lost for the moment before the body arrives, and a reader would
 * see the badges appear and then vanish.
 */
export function markdownAnchorResolver(
  body: string | null,
  marks?: ReadonlyMap<string, LivePassage>,
):
  | ((thread: { readonly id: string; readonly anchor: AnnotationAnchor }) => 'placed' | 'orphaned')
  | undefined {
  if (body === null) return undefined
  return (thread) => {
    // A spatial anchor on a markdown document has nothing here to be judged
    // against — it is not lost, it is about a surface this document does not
    // have. Saying `placed` is the honest answer for "not something I can
    // tell you about".
    if (thread.anchor.kind !== 'text') return 'placed'
    const live = marks?.get(thread.id)
    return resolveTextAnchor(body, thread.anchor, live).kind === 'placed' ? 'placed' : 'orphaned'
  }
}

/**
 * The marks a document ought to carry and does not, derived from the quotes.
 *
 * Marks do not travel through a markdown file: a document imported from OKF
 * arrives with its conversations intact and no live anchor for any of them,
 * as does every thread written before marks existed. Both would work — the
 * quote is the fallback and that is what it is for — but only until someone
 * edits inside a passage or two peers edit either side of one, at which
 * point the quote is the approximation the mark exists to replace.
 *
 * So the quote is asked ONCE, at the moment the body is known, and its
 * answer is written down as a mark the CRDT can then carry. A thread that
 * already has a mark is never re-derived: that would replace the truth with
 * a guess on every load, and would undo wherever a merged edit had carried
 * the passage. A thread whose quote no longer resolves gets nothing —
 * marking the nearest thing would make an orphan look placed forever after,
 * which is what ADR-0026 decision 4 forbids.
 */
export function missingThreadMarks(
  body: string,
  threads: readonly { readonly id: string; readonly anchor: AnnotationAnchor }[],
  marks: ReadonlyMap<string, LivePassage>,
): Map<string, LivePassage> {
  const derived = new Map<string, LivePassage>()
  for (const thread of threads) {
    if (thread.anchor.kind !== 'text') continue
    if (marks.has(thread.id)) continue
    const resolved = resolveTextAnchor(body, thread.anchor)
    if (resolved.kind !== 'placed') continue
    derived.set(thread.id, { start: resolved.start, end: resolved.end })
  }
  return derived
}
