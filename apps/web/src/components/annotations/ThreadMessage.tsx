/**
 * ONE message of a conversation: who wrote it and when, whatever verb acts
 * on it, and its prose.
 *
 * It exists because the first message was special everywhere and should not
 * have been. The rail drew `messages[0]` by hand — its own stamp line, its
 * own Edit — and a `ThreadReplies` component drew `slice(1)`, so the two
 * halves of one conversation were two pieces of markup that could drift,
 * and a verb added to the top one reached no reply. Both hosts map this
 * over every message now, and that second component is gone.
 *
 * What was special about the opening message is a fact about the THREAD (it
 * is the one a row summarises, and on a spatial canvas its text is the flat
 * comment's), never about how a message is drawn.
 *
 * A `<li>`, because a host draws these in the `<ol>` that is the
 * conversation.
 */
import type { CommentMessage } from '@kamiazya/whiteboard-model'
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils.js'
import { CommentBody } from './CommentBody.js'
import { MessageBy } from './message-meta.js'

/**
 * How a message's verb waits for a pointer that can hover.
 *
 * A verb per message is a verb per message always drawn, and a column of
 * pencils is a lot of chrome for prose. Where a mouse exists the row
 * answers to it; where one does not — a phone, which is where this rail is
 * a sheet — nothing hovers, so `pointer-fine:` gates the hiding and a touch
 * device keeps the verb drawn.
 *
 * `opacity`, never `hidden`: the button keeps its box, so the stamp line
 * does not reflow as the pointer crosses it, and it keeps its place in the
 * tab order — which is what `group-focus-within` then makes visible for a
 * reader with no pointer at all.
 *
 * Exported because the coarse-pointer half cannot be rendered here: vitest's
 * browser mode exposes no way to emulate `pointer: coarse` (the limit
 * `dock-button.ts` records for its own 44px step), so the guard reads the
 * rule instead of a computed style it would have taken from the fine branch.
 */
export const THREAD_MESSAGE_ACTION_CLASS =
  'transition-opacity duration-(--motion-duration-fast) pointer-fine:opacity-0 pointer-fine:group-hover/message:opacity-100 pointer-fine:group-focus-within/message:opacity-100'

export interface ThreadMessageProps {
  readonly message: CommentMessage
  /** The panel's dense typography; the card inherits the bubble's own. */
  readonly compact?: boolean
  /**
   * A verb that acts on THIS message, drawn at the trailing edge of its
   * stamp line — so the verbs form a COLUMN down the conversation.
   *
   * It sat beside the stamp first, because with one message that was the
   * only thing naming it: pushed to the trailing edge of a full-width
   * message it stood 239px from the only other thing on its line. Once
   * every message carried one, following the stamp put them at different x
   * positions (measured: 16.2px apart on two messages whose stamps read
   * `9/5 21:29` and `4s ago`) and the short column read as ragged. What
   * names a verb now is the LINE it shares, which a column keeps.
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
    <li className="group/message flex flex-col gap-0.5">
      <div className="flex min-h-4 items-center justify-between gap-2">
        <MessageBy message={message} />
        {action === undefined || action === null ? null : (
          <span className={THREAD_MESSAGE_ACTION_CLASS}>{action}</span>
        )}
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
