/**
 * The box a reply is written in — ONE for both hosts of a conversation.
 *
 * The canvas card and the document-level panel each carried their own copy
 * of this form, and they had already drifted: the card submitted on
 * Cmd/Ctrl+Enter and the panel did not, so the same conversation answered
 * the same chord on one surface and swallowed it on the other. A reply is
 * the same act wherever it is typed; the host decides only what it is a
 * reply TO and how the rest of its surface is sized.
 *
 * Rules that hold on both hosts, so neither can lose one:
 * - The box is a markdown editor (`CommentComposer`), because a comment's
 *   body is markdown. Enter alone is a newline and Cmd/Ctrl+Enter sends;
 *   both live there now, with the rest of the editing verbs.
 * - An empty reply is not a message, guarded at submit rather than by
 *   disabling the button, so the keyboard path is covered by the same rule
 *   as the pointer one.
 * - The draft belongs to the conversation it was typed into. It lives here,
 *   and a host that keys this component by thread gets the reset for free —
 *   moving to another conversation mounts a fresh, empty box rather than
 *   carrying half a sentence across.
 */

import { SendHorizontal } from 'lucide-react'
import { useState } from 'react'
import { ICON_VERB_CLASS } from '../../components/ui/icon-verb.js'
import { cn } from '../../lib/utils.js'
import { CommentComposer } from './CommentComposer.js'

export interface ReplyComposerProps {
  readonly onReply: (body: string) => void
  /** The panel's dense typography; the card inherits the bubble's own. */
  readonly compact?: boolean
  /** Take the caret on mount — for a composer the reader just asked for. */
  readonly autoFocus?: boolean
}

export function ReplyComposer({ onReply, compact = false, autoFocus = false }: ReplyComposerProps) {
  const [draft, setDraft] = useState('')

  function commit(): void {
    const body = draft.trim()
    if (body === '') return
    onReply(body)
    setDraft('')
  }

  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault()
        commit()
      }}
    >
      <CommentComposer
        value={draft}
        onChange={setDraft}
        onSubmit={commit}
        label="Reply"
        placeholderText="Reply…"
        autoFocus={autoFocus}
        compact={compact}
      />
      {/* Icon-only, like every other verb on a conversation — and inert
          while there is nothing to send. The submit stays GUARDED rather
          than disabled so the Meta+Enter path takes the same rule, but with
          no label to read, a press that does nothing has to say why before
          it is pressed. */}
      <button
        type="submit"
        aria-label="Send reply"
        title="Send reply"
        aria-disabled={draft.trim() === ''}
        className={cn(ICON_VERB_CLASS, 'self-end aria-disabled:opacity-40')}
      >
        <SendHorizontal aria-hidden="true" className="size-4" />
      </button>
    </form>
  )
}
