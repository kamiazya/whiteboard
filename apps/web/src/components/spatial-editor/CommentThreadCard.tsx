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
import type { CommentMessage, CommentThread } from '@kamiazya/whiteboard-model'
import { Check, CircleCheck, Pencil, RotateCcw, X } from 'lucide-react'
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { Box } from '../../lib/spatial/geometry.js'
import { CommentComposer } from '../annotations/CommentComposer.js'
import { ReplyComposer } from '../annotations/ReplyComposer.js'
import { ThreadMessage } from '../annotations/ThreadMessage.js'

/** Screen px kept between the card and the root's edge once slid inside. */
const CARD_EDGE_MARGIN_PX = 8

export interface CommentThreadCardProps {
  readonly thread: CommentThread
  /** Where the bubble is drawn, in SCREEN coordinates (root-relative). */
  readonly box: Box
  /** The bubble's own chrome, so the card reads as that bubble opened. */
  readonly style: CSSProperties
  readonly onReply: (body: string) => void
  readonly onResolve: (resolved: boolean) => void
  /** Rewrites ONE message of this conversation, whichever one. */
  readonly onEditMessage: (messageId: string, body: string) => void
  readonly onClose: () => void
}

export function CommentThreadCard({
  thread,
  box,
  style,
  onReply,
  onResolve,
  onEditMessage,
  onClose,
}: CommentThreadCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const resolved = thread.status === 'resolved'
  // The message under edit, with its draft. At most one: two open editors
  // would be two drafts of one conversation, and the Escape that leaves an
  // edit could only unwind one of them.
  const [editing, setEditing] = useState<{ readonly id: string; readonly body: string } | null>(
    null,
  )

  function commitEdit(message: CommentMessage): void {
    if (editing === null) return
    const body = editing.body.trim()
    // An emptied message is a cancel, not a blank one: the schema refuses an
    // empty body.
    if (body !== '' && body !== message.body) onEditMessage(message.id, body)
    setEditing(null)
  }
  // A card opened on a bubble near the root's right or bottom edge is slid
  // back inside once its real size is measurable — the same nudge the
  // context menu gets, for the same reason: the root clips, so a card
  // hanging past the edge has its reply box where no finger can reach it.
  // Sliding rather than panning the canvas keeps the surface still under a
  // reader who only opened a conversation; the keyboard pan is what moves
  // the canvas, and only once they type. useLayoutEffect corrects before
  // paint, so there is no visible jump.
  const [slide, setSlide] = useState({ x: 0, y: 0 })
  const fit = useCallback(() => {
    const el = cardRef.current
    const parent = el?.offsetParent
    if (el == null || !(parent instanceof HTMLElement)) return
    // Measured with the current slide applied, so the correction is taken
    // from the card's natural place: subtract what is already applied.
    const rect = el.getBoundingClientRect()
    const naturalRight = box.x + Math.ceil(rect.width)
    const naturalBottom = box.y + Math.ceil(rect.height)
    const next = {
      x: Math.min(0, parent.clientWidth - CARD_EDGE_MARGIN_PX - naturalRight),
      y: Math.min(0, parent.clientHeight - CARD_EDGE_MARGIN_PX - naturalBottom),
    }
    setSlide((prev) => (prev.x === next.x && prev.y === next.y ? prev : next))
  }, [box.x, box.y])
  useLayoutEffect(fit, [fit, box.width, thread])

  // And again whenever the card's own height changes, which it does AFTER
  // that first measure: the body is laid out by canvas-render once a
  // ResizeObserver has reported the width to wrap to, and the composer is a
  // CodeMirror view created in an effect — both land after layout effects
  // have run, so a one-shot measure slides the card by a height it no
  // longer has and it hangs off the bottom of the root.
  //
  // The one-shot was always fragile for the same reason (a reply arriving
  // from another writer grows the card under a reader who is not touching
  // it); it only became reliably wrong here. No feedback loop: the
  // correction moves the card, it does not resize it.
  useLayoutEffect(() => {
    const el = cardRef.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [fit])

  // Focus the CARD, not its reply box: a press that opens a conversation is
  // a request to read it, and pulling the caret into the box would send the
  // next keystroke somewhere the reader never aimed. Focusing the card is
  // still what makes Escape below reachable — without it the handler sits on
  // an element nothing has focused, and the key goes to the canvas.
  useEffect(() => {
    cardRef.current?.focus()
  }, [])

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
      // Chrome, not canvas: the root's gesture and touch guards recognise
      // the dialog role and its controls on their own, and the attribute
      // says so where a reader looks for it. Without either, a press on the
      // card fell to the root's hit-test — which resolved to the bubble
      // under it and armed a pin drag — and on a phone every tap on it was
      // a cancelled touchstart, so the Close never received its click.
      data-editor-overlay
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        // One layer at a time: an edit in progress first, since shutting the
        // card would discard a draft nobody asked to discard.
        if (editing !== null) setEditing(null)
        else onClose()
      }}
      style={{
        position: 'absolute',
        // Never slid past the root's own origin: a card taller than the
        // root keeps its top edge, where its actions are, in view.
        left: Math.max(0, box.x + slide.x),
        top: Math.max(0, box.y + slide.y),
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
      {/* The THREAD's own verbs, and only those. Edit left this row when
          every message became editable: a verb that acts on one message has
          to sit on that message, or it can only ever mean the first one —
          which is exactly what it meant. */}
      <div className="flex shrink-0 items-center justify-end gap-0.5">
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

      <ol className="flex flex-col gap-3">
        {thread.messages.map((message) => (
          <ThreadMessage
            key={message.id}
            message={message}
            action={
              editing?.id === message.id ? null : (
                <CardAction
                  label="Edit message"
                  testId={`edit-${message.id}`}
                  onSelect={() => setEditing({ id: message.id, body: message.body })}
                >
                  <Pencil className="size-3.5" />
                </CardAction>
              )
            }
            editor={
              editing?.id === message.id ? (
                <form
                  className="flex items-end gap-1"
                  onSubmit={(event) => {
                    event.preventDefault()
                    commitEdit(message)
                  }}
                >
                  <CommentComposer
                    label="Edit message text"
                    value={editing.body}
                    onChange={(body) => setEditing({ id: message.id, body })}
                    onSubmit={() => commitEdit(message)}
                    autoFocus
                    className="min-w-0 flex-1"
                  />
                  <CardAction label="Save" onSelect={() => commitEdit(message)}>
                    <Check className="size-3.5" />
                  </CardAction>
                </form>
              ) : null
            }
          />
        ))}
      </ol>
      <ReplyComposer onReply={onReply} />
    </div>
  )
}

function CardAction({
  label,
  testId,
  onSelect,
  children,
}: {
  readonly label: string
  /** For the verbs there is one of PER MESSAGE, where a name cannot pick one. */
  readonly testId?: string
  readonly onSelect: () => void
  readonly children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      onClick={onSelect}
      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  )
}
