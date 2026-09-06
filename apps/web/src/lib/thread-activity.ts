/**
 * When a conversation last MOVED, as the surfaces that list one need it.
 *
 * A list row carries the OPENING message as its subject, so the stamp beside
 * that subject answers "when was this started" — which is the wrong question
 * for a conversation that has been running for a week. What a reader scanning
 * the list is deciding is whether anything has happened lately, so the row
 * needs the newest stamp the conversation holds, not its oldest.
 *
 * An edit counts as movement: a rewritten subject is news to whoever already
 * read it, and `editedAt` is the only record that it happened.
 */
import type { CommentThread } from '@kamiazya/whiteboard-model'

/**
 * The newest stamp any of the conversation's messages carries, or `undefined`
 * when none carries one — a browser-kept workspace has no signed-in author
 * and need not have written a clock into the record, and saying nothing is
 * the honest answer there rather than inventing a time.
 *
 * Compared by INSTANT rather than as text. `okfTimestampSchema` accepts both
 * `Z` and an explicit `±HH:MM` offset, and midnight in Tokyo is the earlier
 * instant while being the later string — so a lexical max reports a
 * conversation as fresher than it is. (`compareMessages` in the model does
 * compare as text, deliberately: what it needs is one order two peers agree
 * on, and agreement is not the same requirement as chronology.)
 */
export function threadLastActivityAt(thread: CommentThread): string | undefined {
  let newest: string | undefined
  let newestAt = Number.NEGATIVE_INFINITY
  for (const message of thread.messages) {
    for (const stamp of [message.createdAt, message.editedAt]) {
      if (stamp === undefined) continue
      const at = Date.parse(stamp)
      if (Number.isNaN(at) || at <= newestAt) continue
      newest = stamp
      newestAt = at
    }
  }
  return newest
}
