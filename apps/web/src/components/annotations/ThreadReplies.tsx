/**
 * The replies under a conversation's opening message — what a host draws
 * when the opening message is already on screen above them, which today is
 * the canvas card.
 *
 * The rail does NOT use this: it draws every message through
 * `ThreadMessage` in one list, because nothing about how a message is drawn
 * follows from being the first. This slice stays for the card, whose
 * opening message is the flat comment's own text and is edited in place on
 * the canvas (ADR-0025) rather than in the card.
 *
 * The list, its rhythm and its typography; NOT its indent. Where replies sit
 * relative to what they answer is the host's own question and the two hosts
 * answer it differently. Owning a `border-l` here gave the rail a second
 * line inside its first.
 *
 * The rhythm is the grouping: 12px between messages against 2px between a
 * message's stamp and its body. It was 8px against 2px, a ratio too close
 * to read, and the column had no visible seams — which is what a reader
 * calls "everything is jumbled together".
 */
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { ThreadMessage } from './ThreadMessage.js'

export interface ThreadRepliesProps {
  readonly thread: CommentThread
  /** The panel's dense typography; the card inherits the bubble's own. */
  readonly compact?: boolean
}

export function ThreadReplies({ thread, compact = false }: ThreadRepliesProps) {
  if (thread.messages.length <= 1) return null
  return (
    <ol className="flex flex-col gap-3">
      {thread.messages.slice(1).map((message) => (
        <ThreadMessage key={message.id} message={message} compact={compact} />
      ))}
    </ol>
  )
}
