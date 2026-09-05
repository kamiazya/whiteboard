/**
 * One conversation, opened in place on the canvas.
 *
 * The bubble the renderer draws is a PROJECTION of a thread — its opening
 * message and nothing else (`canvasCommentFromThread` is lossy by
 * construction). This card is the thread itself, opened where it is anchored:
 * every message, the lifecycle actions in the top-right, and a reply box that
 * is already there.
 *
 * That the reply box is not behind a verb is the point. It replaced a
 * "Reply" row on the comment's context menu, which asked a reader who had
 * already found the conversation to right-click it and choose a word before
 * they could say anything back — three gestures for the act the surface
 * exists to serve (user decision, 2026-09-04).
 *
 * Positioned in SCREEN coordinates, beside the minimap rather than inside
 * the pan/zoom transform: the transform layer is a stacking context below
 * the ambient chrome, and a card's controls are tap targets whose size
 * should not follow the zoom.
 */
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { CircleCheck, Pencil, RotateCcw, X } from 'lucide-react'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import type { Box } from '../../lib/spatial/geometry.js'
import { MessageBy } from '../annotations/message-meta.js'

export interface CommentThreadCardProps {
  readonly thread: CommentThread
  /** Where the bubble is drawn, in SCREEN coordinates (root-relative). */
  readonly box: Box
  /** The bubble's own chrome, so the card reads as that bubble opened. */
  readonly style: CSSProperties
  readonly onReply: (body: string) => void
  readonly onResolve: (resolved: boolean) => void
  readonly onEdit: () => void
  readonly onClose: () => void
}

export function CommentThreadCard({
  thread,
  box,
  style,
  onReply,
  onResolve,
  onEdit,
  onClose,
}: CommentThreadCardProps) {
  const [draft, setDraft] = useState('')
  const cardRef = useRef<HTMLDivElement | null>(null)
  const resolved = thread.status === 'resolved'

  // Focus the CARD, not its reply box: a press that opens a conversation is
  // a request to read it, and pulling the caret into the box would send the
  // next keystroke somewhere the reader never aimed. Focusing the card is
  // still what makes Escape below reachable — without it the handler sits on
  // an element nothing has focused, and the key goes to the canvas.
  useEffect(() => {
    cardRef.current?.focus()
  }, [])

  function commit(): void {
    const body = draft.trim()
    // An empty reply is not a message. Guarded here rather than by disabling
    // the button, so the keyboard path is covered by the same rule as the
    // pointer one.
    if (body === '') return
    onReply(body)
    setDraft('')
  }

  return (
    <div
      data-testid="comment-card"
      ref={cardRef}
      // Focusable but not in the tab order: the card is opened by a press,
      // and a tab stop on the container would sit in front of its own
      // controls.
      tabIndex={-1}
      // A non-modal dialog: it is a small surface with its own controls,
      // opened over the canvas, that a reader dismisses. The role is what
      // lets it carry the Escape and pointer handlers below — a bare div
      // with interaction handlers is neither announced nor allowed.
      role="dialog"
      aria-label="Comment thread"
      // The card sits exactly on the bubble it opens, so an unguarded
      // pointerdown placing a caret would bubble to the editor root's
      // hit-test, resolve to the same comment, and arm a pin drag —
      // unmounting this card mid-sentence. Same reason TextNodeEditor does it.
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: Math.max(box.width, 216),
        // Above the ambient chrome (minimap and dock are z-10), below the
        // dialogs (z-30). Measured, not guessed: a comment anchored near the
        // bottom-right corner put its card exactly under the minimap, which
        // swallowed every click on the actions — an interception a reader
        // would read as a dead button, not as a stacking bug.
        zIndex: 20,
        ...style,
      }}
      className="flex flex-col gap-2"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap break-words">{thread.messages[0]?.body ?? ''}</p>
          <MessageBy message={thread.messages[0]} />
        </div>
        {/* Top-right, where a card's own verbs belong — reachable without
            hunting for a menu, and out of the text's way. */}
        <div className="flex shrink-0 items-center gap-0.5">
          <CardAction label="Edit comment" onSelect={onEdit}>
            <Pencil className="size-3.5" />
          </CardAction>
          {resolved ? (
            <CardAction label="Reopen" onSelect={() => onResolve(false)}>
              <RotateCcw className="size-3.5" />
            </CardAction>
          ) : (
            <CardAction label="Resolve" onSelect={() => onResolve(true)}>
              <CircleCheck className="size-3.5" />
            </CardAction>
          )}
          <CardAction label="Close" onSelect={onClose}>
            <X className="size-3.5" />
          </CardAction>
        </div>
      </div>

      {thread.messages.length > 1 ? (
        <ol className="flex flex-col gap-1.5 border-l pl-2">
          {thread.messages.slice(1).map((message) => (
            <li key={message.id} className="flex flex-col gap-0.5">
              <MessageBy message={message} />
              <p className="whitespace-pre-wrap break-words">{message.body}</p>
            </li>
          ))}
        </ol>
      ) : null}

      <form
        className="flex flex-col gap-1"
        onSubmit={(event) => {
          event.preventDefault()
          commit()
        }}
      >
        <textarea
          aria-label="Reply"
          placeholder="Reply…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter alone is a newline: a reply is prose, and a conversation
            // that eats paragraph breaks is worse than one extra chord.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              commit()
            }
          }}
          rows={2}
          className="w-full resize-y rounded border bg-background px-2 py-1 text-inherit"
        />
        <button type="submit" className="self-end rounded border px-2 py-1 hover:bg-accent">
          Reply
        </button>
      </form>
    </div>
  )
}

function CardAction({
  label,
  onSelect,
  children,
}: {
  readonly label: string
  readonly onSelect: () => void
  readonly children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onSelect}
      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  )
}
