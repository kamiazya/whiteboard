/**
 * The replies under a conversation's opening message — the list both hosts
 * draw once the subject line is already on screen. The REPLIES, not the
 * whole conversation over again: the card and the panel row each carry the
 * opening message as the subject, and repeating it here read as the same
 * sentence twice. Replies indent under it instead. Nothing when there are
 * none, so a host renders this unconditionally.
 */
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cn } from '../../lib/utils.js'
import { MessageBy } from './message-meta.js'

export interface ThreadRepliesProps {
  readonly thread: CommentThread
  /** The panel's dense typography; the card inherits the bubble's own. */
  readonly compact?: boolean
}

export function ThreadReplies({ thread, compact = false }: ThreadRepliesProps) {
  if (thread.messages.length <= 1) return null
  return (
    <ol className={cn('flex flex-col border-l pl-2', compact ? 'gap-2' : 'gap-1.5')}>
      {thread.messages.slice(1).map((message) => (
        <li key={message.id} className="flex flex-col gap-0.5">
          <MessageBy message={message} />
          <p
            className={cn(
              'whitespace-pre-wrap break-words',
              compact && 'text-xs text-neutral-800 dark:text-neutral-200',
            )}
          >
            {message.body}
          </p>
        </li>
      ))}
    </ol>
  )
}
