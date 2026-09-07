/**
 * The replies under a conversation's opening message — the list both hosts
 * draw once the opening message is already on screen. Nothing when there
 * are none, so a host renders this unconditionally.
 *
 * The list, its rhythm and its typography; NOT its indent. Where the
 * replies sit relative to what they answer is the host's own question and
 * the two hosts answer it differently — the card indents them inside its
 * bubble, while the rail stands the whole conversation, opening message
 * included, in one column under the row's status dot. Owning a `border-l`
 * here gave the rail a second line inside its first.
 *
 * The rhythm is the grouping: 12px between messages against 2px between a
 * message's stamp and its body. It was 8px against 2px, a ratio too close
 * to read, and the column had no visible seams — which is what a reader
 * calls "everything is jumbled together".
 */
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cn } from '../../lib/utils.js'
import { CommentBody } from './CommentBody.js'
import { MessageBy } from './message-meta.js'

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
        <li key={message.id} className="flex flex-col gap-0.5">
          <MessageBy message={message} />
          <CommentBody
            body={message.body}
            compact={compact}
            className={cn(compact && 'text-neutral-800 dark:text-neutral-200')}
          />
        </li>
      ))}
    </ol>
  )
}
