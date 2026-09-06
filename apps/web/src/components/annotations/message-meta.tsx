/**
 * Who wrote a message and when — shared by the document-level rail and the
 * card the canvas opens on a comment, because the two surfaces show the same
 * conversation and a second copy of this would drift from the first.
 */
import type { CommentMessage, CommentThread } from '@kamiazya/whiteboard-model'
import { threadLastActivityAt } from '../../lib/thread-activity.js'
import { formatRelative } from '../workspace-files/format-relative.js'

/**
 * The app's one stamp: "5m ago" while it is fresh, and a local M/D HH:MM
 * once its age stops being the interesting fact — `formatRelative`'s
 * version-timeline variant, because a message and a saved version are the
 * same kind of event to a reader. A UTC ISO slice sat here once, chosen for
 * a deterministic render under CI; that bought the test its stability by
 * showing every reader a clock that was not theirs. Determinism is the
 * test's job (pin the clock, compute the local expectation), not the
 * label's. The machine-readable original rides along in `dateTime`.
 */
function stampOf(iso: string | undefined): {
  readonly text: string
  readonly dateTime: string
} {
  if (iso === undefined) return { text: '', dateTime: '' }
  return { text: formatRelative(iso, { pastDay: 'absolute' }), dateTime: iso }
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

/**
 * How much a conversation holds and when it last moved — the two facts a
 * reader needs BEFORE opening one, and the two the subject line cannot give.
 *
 * The row beside this already carries the opening message and its stamp,
 * which answers "who started this, and when". For a conversation that has
 * been running a week those are the wrong facts: what decides whether to
 * open it is how much is in there and whether anything happened lately.
 *
 * Nothing for a lone remark. Its one stamp IS the opening message's, already
 * on the row, and "1 message" beside it is the same fact written twice.
 */
export function ThreadActivity({ thread }: { readonly thread: CommentThread }) {
  if (thread.messages.length <= 1) return null
  const stamp = stampOf(threadLastActivityAt(thread))
  return (
    <span
      data-testid={`thread-message-count-${thread.id}`}
      className="flex items-center text-[11px] text-muted-foreground"
    >
      <span>{thread.messages.length} messages</span>
      {stamp.text === '' ? null : (
        <>
          {/* The spaces are inside the separator rather than a flex `gap`,
              which draws them without putting them in the text: read aloud,
              a gap between two spans is "2 messages9/3 01:00". */}
          <span aria-hidden="true"> &middot; </span>
          <time dateTime={stamp.dateTime}>{stamp.text}</time>
        </>
      )}
    </span>
  )
}
