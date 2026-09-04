import type { CommentThread } from '@kamiazya/whiteboard-model'

/**
 * Whether two reads of the annotation layer say the same thing.
 *
 * Compares every message BODY, not just the counts: editing a comment's text
 * changes neither the thread count nor the message count, and is exactly the
 * change a cheaper comparison would swallow — the panel would go on showing
 * the old wording until something else moved.
 *
 * Order is significant and is not normalised away. `readAnnotations` fixes it
 * (threads first, legacy rows in map order) because `composeComments` fans a
 * later bubble around an earlier one, so two reads differing only in order
 * really do draw differently.
 *
 * Its own module because both readers of the layer need it and they share
 * nothing else: the spatial session republishes on a commit, and the markdown
 * hook republishes on a doc subscription that also fires for every keystroke
 * in the body. Without the guard that second caller would hand the panel a
 * fresh array on each character typed.
 */
export function sameAnnotations(a: readonly CommentThread[], b: readonly CommentThread[]): boolean {
  if (a.length !== b.length) return false
  return a.every((thread, index) => {
    const other = b[index]
    if (other === undefined) return false
    if (thread.id !== other.id || thread.status !== other.status) return false
    if (thread.messages.length !== other.messages.length) return false
    if (JSON.stringify(thread.anchor) !== JSON.stringify(other.anchor)) return false
    return thread.messages.every((message, messageIndex) => {
      const otherMessage = other.messages[messageIndex]
      return message.id === otherMessage?.id && message.body === otherMessage.body
    })
  })
}
