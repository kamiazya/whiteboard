/**
 * One conversation's row in the panel's list.
 *
 * Its own module because the row is where the panel's MODES live — expanded
 * or not, being edited or not, leaving or staying — and each of those was a
 * conditional inside one map callback.
 */
import type {
  AnnotationAnchor,
  CommentThread,
  CommentThreadStatus,
} from '@kamiazya/whiteboard-model'
import { Check, Pencil } from 'lucide-react'
import type { RefObject } from 'react'
import { ICON_VERB_CLASS } from '../../components/ui/icon-verb.js'
import { commentExcerpt } from '../../lib/comment-excerpt.js'
import { cn } from '../../lib/utils.js'
import { CommentComposer } from './CommentComposer.js'
import type { CommentsPanelProps, ThreadFilter } from './CommentsPanel.js'
import { MessageBy, ThreadActivity } from './message-meta.js'
import { ReplyComposer } from './ReplyComposer.js'
import { ThreadMessage } from './ThreadMessage.js'

export interface ThreadEdit {
  readonly threadId: string
  readonly messageId: string
  readonly body: string
}

/**
 * The first message is the conversation's subject — replies are read by
 * opening it, not by scanning the list.
 *
 * As TEXT, not as the markdown it is: the row is a two-line clamp inside a
 * button, and the rendered body is an SVG that neither `line-clamp` nor a
 * button's semantics survive. Before this it showed the SOURCE, so a reader
 * scanning the rail saw `**tighten**` while the card beside it drew
 * emphasis.
 */
function excerptOf(thread: CommentThread): string {
  return commentExcerpt(thread.messages[0]?.body ?? '')
}

/**
 * What a thread is about, for the anchors that have no in-place projection
 * to say it for them: the document, a node set, a region. A pin, a passage
 * highlight or an edge comment is found by its place; these are found here.
 */
export function anchorLabel(anchor: AnnotationAnchor): string | undefined {
  if (anchor.kind === 'document') return 'whole document'
  if (anchor.kind !== 'spatial') return undefined
  if (anchor.nodeIds !== undefined) return `${anchor.nodeIds.length} nodes`
  if (anchor.width !== undefined) return 'region'
  return undefined
}

/** Every message in the conversation, each one editable in place. */
function ThreadMessages({
  thread,
  editing,
  setEditing,
  commitEdit,
  onEditMessage,
}: {
  thread: CommentThread
  editing: ThreadEdit | null
  setEditing: (next: ThreadEdit | null) => void
  commitEdit: (thread: CommentThread) => void
  onEditMessage: CommentsPanelProps['onEditMessage']
}) {
  return (
    <ol className="flex flex-col gap-3">
      {thread.messages.map((message) => (
        <ThreadMessage
          key={message.id}
          message={message}
          compact
          action={
            onEditMessage === undefined || editing?.messageId === message.id ? null : (
              <button
                type="button"
                data-testid={`edit-${message.id}`}
                aria-label="Edit message"
                title="Edit message"
                onClick={() =>
                  setEditing({
                    threadId: thread.id,
                    messageId: message.id,
                    body: message.body,
                  })
                }
                // Sunk into the stamp line rather than given
                // a row: `-my-3.5` spends the 44px tap
                // target across the 16px line it sits on, so
                // the verb is beside what it edits instead
                // of a lone pencil pushing the conversation
                // down by 44px.
                className={cn(ICON_VERB_CLASS, '-my-3.5')}
              >
                <Pencil aria-hidden="true" className="size-4" />
              </button>
            )
          }
          editor={
            editing?.messageId === message.id ? (
              <form
                data-testid="comment-edit"
                className="flex items-end gap-1"
                onSubmit={(event) => {
                  event.preventDefault()
                  commitEdit(thread)
                }}
              >
                <CommentComposer
                  autoFocus
                  label="Edit message text"
                  value={editing.body}
                  onChange={(body) =>
                    setEditing({
                      threadId: thread.id,
                      messageId: message.id,
                      body,
                    })
                  }
                  onSubmit={() => commitEdit(thread)}
                  compact
                  className="min-w-0 flex-1"
                />
                {/* No Cancel button: Escape already leaves
                    the edit, and an X here would be the
                    third meaning of that glyph in one
                    panel. */}
                <button
                  type="submit"
                  aria-label="Save"
                  title="Save"
                  aria-disabled={editing.body.trim() === ''}
                  className={cn(ICON_VERB_CLASS, '-my-2 aria-disabled:opacity-40')}
                >
                  <Check aria-hidden="true" className="size-4" />
                </button>
              </form>
            ) : null
          }
        />
      ))}
    </ol>
  )
}

/**
 * The open conversation: its messages, and the box to answer them in.
 *
 * ONE column for the whole conversation, standing on the row's own text
 * edge, so a reply reads as belonging to the message it answers rather than
 * floating outdented beside it.
 */
function ThreadConversation({
  thread,
  editing,
  setEditing,
  commitEdit,
  onReply,
  onEditMessage,
}: {
  thread: CommentThread
  editing: ThreadEdit | null
  setEditing: (next: ThreadEdit | null) => void
  commitEdit: (thread: CommentThread) => void
  onReply: CommentsPanelProps['onReply']
  onEditMessage: CommentsPanelProps['onEditMessage']
}) {
  return (
    // ONE column for the whole conversation, standing on the
    // row's own text edge: `44px` of status dot puts the row's
    // 2px gap at 44 and its text at 54, so the rule fills that
    // gap channel and the column's content lands on 54 — under
    // the summary it belongs to. Before this the summary
    // started at 54px and the replies at 17px, outdented from
    // the message they answer with nothing tying either to the
    // dot.
    //
    // `border-l-2`, the weight the compose box's quote already
    // uses for the same job. Measured at `border-l` first: the
    // token resolves to `oklch(1 0 0 / 0.1)` in the dark theme,
    // which on this ground is invisible — a connector nobody
    // can see is not one.
    <div id={`thread-${thread.id}`} className="mt-1 ml-[44px] flex flex-col gap-3 border-l-2 pl-2">
      {/* Every message, drawn the same way. The first one
            used to be built here by hand and the rest by
            a replies-only component, which is why only the
            first could be edited: the verb was in the half that
            only ever held one message. What is special about the opening
            message belongs to the THREAD — a row summarises it,
            and on a canvas its text is the flat comment's — not
            to how a message is drawn. */}
      <ThreadMessages
        thread={thread}
        editing={editing}
        setEditing={setEditing}
        commitEdit={commitEdit}
        onEditMessage={onEditMessage}
      />

      {onReply === undefined ? null : (
        // Keyed by thread, which is what makes the draft belong
        // to the conversation it was typed into: moving to
        // another one mounts a fresh box instead of carrying
        // half a sentence across.
        <ReplyComposer key={thread.id} compact onReply={(body) => onReply(thread.id, body)} />
      )}
    </div>
  )
}

export function ThreadRow({
  thread,
  openThreadId,
  filter,
  pending,
  editing,
  setEditing,
  commitEdit,
  statusOf,
  toggle,
  resolveWithBeat,
  resolveAnchor,
  onResolve,
  onReply,
  onEditMessage,
  rowRefs,
}: {
  thread: CommentThread
  openThreadId: string | null
  filter: ThreadFilter
  pending: ReadonlyMap<string, CommentThreadStatus>
  editing: { readonly threadId: string; readonly messageId: string; readonly body: string } | null
  setEditing: (
    next: { readonly threadId: string; readonly messageId: string; readonly body: string } | null,
  ) => void
  commitEdit: (thread: CommentThread) => void
  statusOf: (thread: CommentThread) => CommentThreadStatus
  toggle: (thread: CommentThread) => void
  resolveWithBeat: (thread: CommentThread) => void
  resolveAnchor: CommentsPanelProps['resolveAnchor']
  onResolve: CommentsPanelProps['onResolve']
  onReply: CommentsPanelProps['onReply']
  onEditMessage: CommentsPanelProps['onEditMessage']
  rowRefs: RefObject<Map<string, HTMLButtonElement>>
}) {
  const expanded = thread.id === openThreadId
  // What the ROW says, which during a beat is what was just asked
  // for rather than what the document has answered yet.
  const status = statusOf(thread)
  // Held, and no longer belonging in this list: the row that gets
  // the leave animation. Under `all` nothing leaves, so the
  // crossing is the whole transition and this stays false.
  const leaving = pending.has(thread.id) && filter !== 'all' && status !== filter
  return (
    <li
      data-thread-id={thread.id}
      data-status={status}
      className={cn(leaving && 'comment-row-leaving')}
    >
      <div className="flex items-start gap-0.5">
        {/* The status dot IS the Resolve toggle. One object holds
            the state and changes it, so the press lands on the
            thing that then changes — which is what makes the
            transition legible; a version that crossed the marker
            while the row cut read as no animation at all.

            A SIBLING of the row's own toggle, never inside it: a
            button within a button is invalid and collapses the
            accessibility tree, which is why merging the two
            restructured the row rather than adding a class. */}
        {onResolve === undefined ? (
          <span className="grid size-11 shrink-0 place-items-center">
            <span className="annotation-dot" data-status={status} aria-hidden="true" />
          </span>
        ) : (
          <button
            type="button"
            aria-label={status === 'resolved' ? 'Reopen' : 'Resolve'}
            title={status === 'resolved' ? 'Reopen' : 'Resolve'}
            onClick={() => resolveWithBeat(thread)}
            className={ICON_VERB_CLASS}
          >
            <span className="annotation-dot" data-status={status}>
              <Check aria-hidden="true" />
            </span>
          </button>
        )}
        <button
          type="button"
          ref={(node) => {
            if (node === null) rowRefs.current.delete(thread.id)
            else rowRefs.current.set(thread.id, node)
          }}
          aria-expanded={expanded}
          aria-controls={`thread-${thread.id}`}
          onClick={() => toggle(thread)}
          // No `TOGGLE_STATE_CLASS` here, deliberately. That fill
          // is how a control whose effect is ELSEWHERE says it is
          // on — the header button that opens this rail has no
          // other way to say so. A disclosure says it by
          // disclosing: the conversation appears right under this
          // row, indented and ruled. Filling the row as well made
          // a solid slab of the one line on screen that is pure
          // chrome, sitting above the prose that is the point.
          className={cn(
            'min-w-0 flex-1 rounded px-2 py-1.5 text-left text-xs hover:bg-accent',
            // Open, the row is one meta line; centring it in the
            // dot's own 44px keeps the collapse target a target.
            expanded && 'flex min-h-11 flex-col justify-center',
          )}
        >
          {/* A summary is what a CLOSED conversation shows. Open,
              the messages are right below it, so drawing this too
              put the same sentence on screen twice — and at two
              sizes, 12px row chrome against 14px prose. `sr-only`
              rather than unrendered: it is still the name of the
              control that collapses this conversation, and a row
              named "whole document 3 messages 0s ago" is not one
              anybody could act on. */}
          <span
            className={cn(
              'comment-row-subject line-clamp-2 text-neutral-800 dark:text-neutral-200',
              expanded && 'sr-only',
            )}
          >
            {excerptOf(thread)}
          </span>
          <span className="comment-row-meta mt-0.5 flex items-center gap-2 text-[11px] text-neutral-500">
            {anchorLabel(thread.anchor) === undefined ? null : (
              <span data-testid={`thread-about-${thread.id}`}>{anchorLabel(thread.anchor)}</span>
            )}
            {/* Exactly one of these draws, by construction:
                `ThreadActivity` is silent on a lone remark, whose
                only stamp IS the opening message's. A conversation
                shows what a closed row can answer — how much is in
                here and whether it moved lately — and leaves the
                opening stamp to the first entry of the column one
                tap away. Both at once wrapped the row at 390px. */}
            {thread.messages.length <= 1 ? <MessageBy message={thread.messages[0]} /> : null}
            <ThreadActivity thread={thread} />
            {resolveAnchor?.(thread) === 'orphaned' ? (
              <span data-testid={`thread-orphaned-${thread.id}`}>
                {/* Said, not hidden: the conversation outlived what it
                  was about, which is ordinary once a document is
                  edited — not an error state. */}
                anchor gone
              </span>
            ) : null}
          </span>
        </button>
      </div>

      {expanded ? (
        <ThreadConversation
          thread={thread}
          editing={editing}
          setEditing={setEditing}
          commitEdit={commitEdit}
          onReply={onReply}
          onEditMessage={onEditMessage}
        />
      ) : null}
    </li>
  )
}
