/**
 * ONE message of a conversation: who wrote it and when, whatever verb acts
 * on it, and its prose.
 *
 * It exists because the first message was special everywhere and should not
 * have been. The rail drew `messages[0]` by hand — its own stamp line, its
 * own Edit — and `ThreadReplies` drew `slice(1)`, so the two halves of one
 * conversation were two pieces of markup that could drift, and a verb added
 * to the top one reached no reply. What was special about the opening
 * message is a fact about the THREAD (it is the one a row summarises, and
 * on a spatial canvas its text is the flat comment's), never about how a
 * message is drawn.
 *
 * A `<li>`, because a host draws these in the `<ol>` that is the
 * conversation.
 */
import type { CommentMessage } from '@kamiazya/whiteboard-model'
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils.js'
import { CommentBody } from './CommentBody.js'
import { MessageBy } from './message-meta.js'

export interface ThreadMessageProps {
  readonly message: CommentMessage
  /** The panel's dense typography; the card inherits the bubble's own. */
  readonly compact?: boolean
  /**
   * A verb that acts on THIS message, drawn beside its stamp. Beside, not
   * at the trailing edge: on a full-width message that left 239px between
   * the pencil and the only other thing on its line, and proximity is the
   * only thing naming an unlabelled verb.
   */
  readonly action?: ReactNode
  /**
   * Drawn INSTEAD of the body — the editor, while this message is being
   * rewritten. Nullish means "not being edited", so a host may pass the
   * result of a conditional either way round.
   */
  readonly editor?: ReactNode
}

export function ThreadMessage({ message, compact = false, action, editor }: ThreadMessageProps) {
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex min-h-4 items-center gap-1">
        <MessageBy message={message} />
        {action}
      </div>
      {editor ?? (
        <CommentBody
          body={message.body}
          compact={compact}
          className={cn(compact && 'text-neutral-800 dark:text-neutral-200')}
        />
      )}
    </li>
  )
}
