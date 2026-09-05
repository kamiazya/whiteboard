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
 * - Enter alone is a newline: a reply is prose, and a conversation that
 *   eats paragraph breaks is worse than one extra chord. Cmd/Ctrl+Enter
 *   sends, matching every other editor in the app.
 * - An empty reply is not a message, guarded at submit rather than by
 *   disabling the button, so the keyboard path is covered by the same rule
 *   as the pointer one.
 * - The draft belongs to the conversation it was typed into. It lives here,
 *   and a host that keys this component by thread gets the reset for free —
 *   moving to another conversation mounts a fresh, empty box rather than
 *   carrying half a sentence across.
 */
import { useState } from 'react'
import { cn } from '../../lib/utils.js'

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
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the composer only mounts because the reader asked to write; the caret is the request answered
        autoFocus={autoFocus}
        aria-label="Reply"
        aria-keyshortcuts="Meta+Enter Control+Enter"
        placeholder="Reply…"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            commit()
          }
        }}
        rows={2}
        className={cn(
          'w-full resize-y rounded border bg-background px-2 py-1',
          compact ? 'text-xs' : 'text-inherit',
        )}
      />
      <button
        type="submit"
        className={cn('self-end rounded border px-2 py-1 hover:bg-accent', compact && 'text-xs')}
      >
        Reply
      </button>
    </form>
  )
}
