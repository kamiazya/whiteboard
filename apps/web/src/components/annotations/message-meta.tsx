/**
 * Who wrote a message and when — shared by the document-level rail and the
 * card the canvas opens on a comment, because the two surfaces show the same
 * conversation and a second copy of this would drift from the first.
 */
import type { CommentMessage } from '@kamiazya/whiteboard-model'

/**
 * Locale- and clock-independent, deliberately: `toLocaleString` reads the
 * runner's timezone (so the same thread renders differently in CI than on a
 * laptop) and a relative "2 days ago" would make every rendering depend on
 * the wall clock. What a reader needs here is which message came first, and
 * an absolute stamp answers that without either dependency. The machine-
 * readable original rides along in `dateTime`.
 */
function stampOf(iso: string | undefined): {
  readonly text: string
  readonly dateTime: string
} {
  if (iso === undefined) return { text: '', dateTime: '' }
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return { text: '', dateTime: iso }
  return { text: parsed.toISOString().slice(0, 16).replace('T', ' '), dateTime: iso }
}

/**
 * Who wrote a message and when, or nothing when the message says neither.
 *
 * `okfActor` is a bare single-line string with no kind, and this app has no
 * accounts, so there is nothing here to infer a human-vs-AI badge FROM. The
 * name when one was written, and silence otherwise — inventing the
 * distinction from a free string would be a guess wearing a badge.
 */
export function MessageBy({ message }: { readonly message: CommentMessage | undefined }) {
  if (message === undefined) return null
  const stamp = stampOf(message.createdAt)
  if (message.author === undefined && stamp.text === '') return null
  return (
    <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
      {message.author !== undefined ? <span>{message.author}</span> : null}
      {stamp.text !== '' ? <time dateTime={stamp.dateTime}>{stamp.text}</time> : null}
    </span>
  )
}
