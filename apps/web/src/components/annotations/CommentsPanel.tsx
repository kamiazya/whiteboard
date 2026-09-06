/**
 * The annotation layer's document-level surface (ADR-0026 decision 5).
 *
 * ONE component, two hosts. The canvas keeps its pins and bubbles and the
 * markdown editor gets its own in-place projection, but "which conversations
 * are open on this document" is a list, and a list is the same in both.
 *
 * It exists because the show/hide toggle it supersedes could not answer three
 * things, none of them a matter of taste: a markdown document has no
 * empty-canvas context menu to hang a toggle on, an ORPHANED thread has
 * nowhere on a surface to be drawn and therefore nowhere to be reached, and
 * "show resolved" answers whether resolved comments are drawn when what a
 * reader wants at document level is which ones are still open.
 */
import type {
  AnnotationAnchor,
  CommentThread,
  CommentThreadStatus,
} from '@kamiazya/whiteboard-model'
import { Check, MessageSquarePlus, Pencil, SendHorizontal } from 'lucide-react'
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { TOGGLE_STATE_CLASS } from '../../components/ui/dock-button.js'
import { ICON_VERB_CLASS } from '../../components/ui/icon-verb.js'
import { commentExcerpt } from '../../lib/comment-excerpt.js'
import { cn } from '../../lib/utils.js'
import { CommentBody } from './CommentBody.js'
import { MessageBy, ThreadActivity } from './message-meta.js'
import { ReplyComposer } from './ReplyComposer.js'
import { ThreadReplies } from './ThreadReplies.js'

/**
 * Which conversations the reader is looking at. **Per-user view state, never
 * written to the document** (ADR-0025 decision 2's surviving half): one
 * person's filter must not change what another sees.
 */
export type ThreadFilter = 'open' | 'resolved' | 'all'

const FILTERS: readonly { readonly value: ThreadFilter; readonly label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' },
]

export interface CommentsPanelProps {
  readonly threads: readonly CommentThread[]
  /**
   * Whether a thread's anchor still finds its place. A host that can answer
   * (the canvas knows whether the node is gone) passes one; absent, nothing
   * is marked orphaned, which is the right default for a host that cannot
   * tell rather than a claim that every anchor resolves.
   */
  readonly resolveAnchor?: (thread: CommentThread) => 'placed' | 'orphaned'
  /** Reveal the thread in the host's own surface. */
  readonly onSelect?: (thread: CommentThread) => void
  /**
   * Appends a message to a conversation. Absent hides the reply box entirely
   * rather than showing a control that silently does nothing — a host with no
   * write path (a read-only view, or one with no session yet) has no reply to
   * offer, and saying so by omission is the honest form.
   */
  readonly onReply?: (threadId: string, body: string) => void
  /**
   * A conversation the HOST wants shown — the other end of `onSelect`, for
   * when the reader reached a thread through the surface instead of through
   * this list (pressing its gutter marker in a markdown body).
   *
   * It expands the thread and, when the current filter would have hidden it,
   * widens the filter: a resolved conversation the reader explicitly asked
   * for must not open into an empty list, which reads as the press doing
   * nothing.
   */
  readonly revealThreadId?: string | null
  /**
   * A passage the reader asked to comment on, waiting for its first message.
   *
   * The ANCHOR and not a thread, because `commentThreadSchema` has no legal
   * empty thread: a conversation with nothing said in it cannot be written,
   * so the passage stays UI state here until there is a message to create it
   * with. That is also why this surface owns the draft — an unsubmitted one
   * must not reach the document.
   *
   * Typed as the whole anchor union rather than the text arm: what a passage
   * IS belongs to the host, and this panel only quotes it back and hands it
   * over.
   */
  readonly composeAnchor?: AnnotationAnchor | null
  /**
   * Opens a conversation about `composeAnchor`. Absent hides the compose box
   * for the same reason `onReply`'s absence hides the reply box.
   */
  readonly onCreateThread?: (anchor: AnnotationAnchor, body: string) => void
  /** Abandons the passage without writing anything. */
  readonly onCancelCompose?: () => void
  /**
   * Opens a compose box about the document as a whole — the one anchor with
   * no place on any surface, so this list is where it is started as well as
   * read. Absent on a host with no write path, like `onCreateThread`.
   */
  readonly onComposeDocument?: () => void
  /**
   * Closes or reopens a conversation. The canvas card carries the same verb
   * on its top-right; here it is what lets a NOTE's thread be closed at all,
   * since a note has no card. Absent hides the control, like `onReply`.
   */
  readonly onResolve?: (threadId: string, resolved: boolean) => void
  /** Rewrites the opening message. Absent hides the control, like `onReply`. */
  readonly onEditMessage?: (threadId: string, messageId: string, body: string) => void
  /**
   * Hands focus back to the surface this panel was opened from — what
   * Escape means here. Absent leaves Escape alone rather than dropping the
   * reader somewhere unnamed: a host that cannot say where they came from
   * has nowhere to send them.
   */
  readonly onReturnFocus?: () => void
}

/**
 * How long a resolved row stays on screen after it has crossed, before it
 * leaves the list it no longer belongs in.
 *
 * The crossing carries the meaning and the hold is what makes it readable;
 * without one the row changes and vanishes inside the same gesture, which is
 * the cut this replaces. Not collapsed under `prefers-reduced-motion`: the
 * global floor in `index.css` already flattens the MOVEMENT, and a reader who
 * asked for less motion still has to see what their press did.
 *
 * The two durations beside it are the motion tokens; this one is a number
 * because there is no token for "long enough to read a state change" yet.
 */
const RESOLVE_HOLD_MS = 200
const RESOLVE_LEAVE_MS = 220

function matches(thread: CommentThread, filter: ThreadFilter): boolean {
  return filter === 'all' || thread.status === filter
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
 * Whether the expanded conversation should draw its opening message, given
 * that the row above it is already showing a summary of the same message.
 *
 * The panel used to draw it unconditionally and that was reverted, for a
 * reason that still holds: on a one-line plain comment the two are the same
 * sentence twice. What changed is that the row is now a LOSSY summary — the
 * syntax stripped, the blocks joined, clamped to two lines — so for a body
 * that has any of that in it the rendering is not a repeat, it is the
 * message. Comparing the two is what tells them apart, rather than a taste
 * call about which comments deserve it.
 */
function excerptLosesSomething(body: string): boolean {
  return commentExcerpt(body) !== body.trim()
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

export function CommentsPanel({
  threads,
  resolveAnchor,
  onSelect,
  onReply,
  revealThreadId = null,
  composeAnchor = null,
  onCreateThread,
  onCancelCompose,
  onComposeDocument,
  onResolve,
  onEditMessage,
  onReturnFocus,
}: CommentsPanelProps) {
  const [filter, setFilter] = useState<ThreadFilter>('open')
  // At most one conversation is open at a time. A panel of simultaneously
  // expanded threads is a wall of text with no shape; reading one and
  // replying to it is the act this surface serves.
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)
  // The opening message under edit, with its draft: at most one, and it
  // belongs to the row, so opening another conversation abandons it.
  const [editing, setEditing] = useState<{
    readonly threadId: string
    readonly body: string
  } | null>(null)

  // Adjusting state during render on a changed prop, rather than in an
  // effect: an effect would paint the list once without the thread the
  // reader just asked for.
  //
  // Seeded `null`, never `revealThreadId`. The rail is MOUNTED by the same
  // press that names the thread — the host opens the panel and selects in
  // one go — so seeding it with the incoming id makes the first render
  // "already seen", and the panel arrives with the conversation collapsed.
  // Measured: the rail opened and stopped exactly there.
  const [lastRevealed, setLastRevealed] = useState<string | null>(null)
  if (revealThreadId !== lastRevealed) {
    setLastRevealed(revealThreadId)
    if (revealThreadId !== null) {
      setOpenThreadId(revealThreadId)
      const revealed = threads.find((t) => t.id === revealThreadId)
      if (revealed !== undefined && !matches(revealed, filter)) setFilter('all')
    }
  }

  // Same render-time adjustment as the reveal above, and the same reason:
  // the passage arrives with the press that opens this panel, so an effect
  // would paint the rail once without the box the reader just asked for.
  const [composeDraft, setComposeDraft] = useState('')
  const [lastCompose, setLastCompose] = useState<AnnotationAnchor | null>(null)
  if (composeAnchor !== lastCompose) {
    setLastCompose(composeAnchor)
    if (composeAnchor !== null) {
      setComposeDraft('')
      // One thing at a time: an expanded conversation beside a new draft box
      // is two reply fields on screen, and the reader has to work out which
      // one they are typing into.
      setOpenThreadId(null)
      // A new conversation is `open`, so Resolved is the one filter that
      // would hide it — and a create whose result never appears reads as a
      // create that failed.
      if (filter === 'resolved') setFilter('open')
    }
  }

  /**
   * Where the reader is put when a conversation is opened from outside this
   * panel. Reading a conversation and writing the body are two modes, and a
   * press that opens one has to move the reader into it — otherwise the
   * caret stays in the document, the keyboard keeps typing into it, and on a
   * phone the virtual keyboard stays up over the rail that just opened.
   */
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const composeRef = useRef<HTMLTextAreaElement | null>(null)
  const editRef = useRef<HTMLTextAreaElement | null>(null)

  // The ROW's toggle rather than its reply box: it is the conversation's
  // heading, and Tab continues from it into the verbs, the replies and the
  // reply box in the order they are read.
  useEffect(() => {
    if (revealThreadId === null) return
    rowRefs.current.get(revealThreadId)?.focus()
  }, [revealThreadId])

  // A new conversation has nothing to read, so the draft box is the whole
  // of what was asked for.
  useEffect(() => {
    if (composeAnchor === null) return
    composeRef.current?.focus()
  }, [composeAnchor])

  // Keyed on the thread rather than on `editing`, which changes on every
  // keystroke — the focus belongs to opening the editor, not to typing in it.
  const editingThreadId = editing?.threadId ?? null
  useEffect(() => {
    if (editingThreadId === null) return
    editRef.current?.focus()
  }, [editingThreadId])

  /**
   * Escape is the way back out, and it unwinds one layer at a time: an edit
   * in progress first (leaving the panel would discard it without the reader
   * having asked to leave), then the panel itself.
   */
  function onEscape(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Escape') return
    if (editing !== null) {
      const row = rowRefs.current.get(editing.threadId)
      setEditing(null)
      // Taken before React unmounts the textarea: focus on a removed node
      // falls to the body, and the next Escape would then never reach this
      // handler at all.
      row?.focus()
      event.stopPropagation()
      return
    }
    // The draft's own way out. Its Cancel BUTTON is gone — an X there
    // collides with the X that closes the panel, same glyph and two
    // scopes — so the key that already meant this carries it alone.
    //
    // BOTH effects, unlike the edit above: the draft box is what focus was
    // moved to when the passage was picked, so taking it away without
    // handing focus back would drop the reader on the body with nothing
    // selected and no way back to their caret.
    if (composeAnchor !== null && onCancelCompose !== undefined) {
      onCancelCompose()
      onReturnFocus?.()
      event.stopPropagation()
      return
    }
    if (onReturnFocus === undefined) return
    event.stopPropagation()
    onReturnFocus()
  }

  /**
   * The status the reader just ASKED for, per conversation, held for one
   * beat — long enough for the change to be read before the row acts on it.
   *
   * Optimistic on purpose, and it is the beat's whole point: the row has to
   * wear its new state while it is being held, and the state otherwise
   * arrives from the host a render later. Without it the row sits unchanged
   * for the hold and then vanishes, which is the cut this replaces with an
   * extra pause in front of it. Measured: with a host that had not answered
   * yet, the held row still read `open`.
   *
   * The WRITE is never delayed — `onResolve` fires on the press, so a peer
   * sees it at once and a reader who navigates away mid-beat loses nothing.
   * Only the presentation waits, and only until the host answers.
   */
  const [pending, setPending] = useState<ReadonlyMap<string, CommentThreadStatus>>(() => new Map())
  const listRef = useRef<HTMLUListElement | null>(null)
  const rowTops = useRef(new Map<string, number>())
  const lastFilter = useRef(filter)

  /** What a row should SAY it is: what was just asked for, else the document. */
  const statusOf = (thread: CommentThread): CommentThreadStatus =>
    pending.get(thread.id) ?? thread.status

  function resolveWithBeat(thread: CommentThread): void {
    if (onResolve === undefined) return
    const next: CommentThreadStatus = statusOf(thread) === 'resolved' ? 'open' : 'resolved'
    onResolve(thread.id, next === 'resolved')
    setPending((prev) => new Map(prev).set(thread.id, next))
    window.setTimeout(() => {
      setPending((prev) => {
        if (!prev.has(thread.id)) return prev
        const rest = new Map(prev)
        rest.delete(thread.id)
        return rest
      })
    }, RESOLVE_HOLD_MS + RESOLVE_LEAVE_MS)
  }

  // A conversation being held stays listed whatever the filter says, which
  // is what gives the beat somewhere to happen.
  const shown = useMemo(
    () => threads.filter((t) => matches(t, filter) || pending.has(t.id)),
    [threads, filter, pending],
  )

  /**
   * FLIP: the rows below a departing one glide into the gap instead of
   * snapping up. Compositor-only, which is what DESIGN.md's motion rule
   * asks for — the list never animates its own height.
   *
   * Skipped on a filter change, which is a different list rather than a
   * move: gliding there would animate rows between positions they never
   * travelled between.
   */
  useLayoutEffect(() => {
    const list = listRef.current
    const filterChanged = lastFilter.current !== filter
    lastFilter.current = filter
    if (list === null) {
      rowTops.current.clear()
      return
    }
    const seen = new Set<string>()
    for (const child of list.children) {
      const row = child as HTMLElement
      const id = row.dataset.threadId
      if (id === undefined) continue
      seen.add(id)
      const top = row.getBoundingClientRect().top
      const was = rowTops.current.get(id)
      rowTops.current.set(id, top)
      if (filterChanged || was === undefined || Math.abs(was - top) < 0.5) continue
      row.animate([{ transform: `translateY(${was - top}px)` }, { transform: 'none' }], {
        duration: RESOLVE_LEAVE_MS,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      })
    }
    for (const id of [...rowTops.current.keys()]) if (!seen.has(id)) rowTops.current.delete(id)
  })

  function toggle(thread: CommentThread): void {
    setOpenThreadId((current) => (current === thread.id ? null : thread.id))
    onSelect?.(thread)
  }

  return (
    <section
      aria-label="Comments"
      data-testid="comments-panel"
      onKeyDown={onEscape}
      className="flex flex-col gap-2"
    >
      {composeAnchor === null && onComposeDocument !== undefined ? (
        <button
          type="button"
          data-testid="comment-on-document"
          onClick={onComposeDocument}
          className="flex items-center gap-1 self-start rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <MessageSquarePlus aria-hidden="true" className="size-3.5" />
          Comment on the document
        </button>
      ) : null}
      <fieldset aria-label="Filter comments" className="flex gap-1 border-0 p-0">
        {FILTERS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            // Theme TOKENS, not raw palette steps: `bg-neutral-200
            // dark:bg-neutral-700` was a second colour system beside the one
            // every other control uses, and it does not follow a theme change.
            className={cn(
              'rounded px-2 py-1 text-xs text-muted-foreground aria-pressed:font-medium',
              TOGGLE_STATE_CLASS,
            )}
          >
            {label}
          </button>
        ))}
      </fieldset>

      {composeAnchor !== null && onCreateThread !== undefined ? (
        <form
          data-testid="comments-panel-compose"
          className="flex flex-col gap-1 rounded border p-2"
          onSubmit={(event) => {
            event.preventDefault()
            const body = composeDraft.trim()
            // Same rule as the reply box, in the same place: guarded on
            // submit rather than by disabling the button, so pressing Enter
            // in the field is covered by it too.
            if (body === '') return
            onCreateThread(composeAnchor, body)
            setComposeDraft('')
          }}
        >
          {composeAnchor.kind === 'text' ? (
            // Quoted back because by the time the reader is typing here,
            // their selection in the body is no longer what they are looking
            // at — and a comment about the wrong passage is worse than none.
            <p className="line-clamp-2 border-l-2 pl-2 text-xs text-neutral-500 italic">
              {composeAnchor.quote.exact}
            </p>
          ) : anchorLabel(composeAnchor) === undefined ? null : (
            <p data-testid="comments-panel-compose-about" className="text-xs text-neutral-500">
              About the {anchorLabel(composeAnchor)}
            </p>
          )}
          <textarea
            ref={composeRef}
            aria-label="Comment"
            value={composeDraft}
            onChange={(event) => setComposeDraft(event.target.value)}
            rows={2}
            className="w-full resize-y rounded border bg-background px-2 py-1 text-xs"
          />
          <div className="flex justify-end">
            {/* Guarded on submit rather than disabled, so pressing Enter in
                the field takes the same rule — but with no label to read, a
                press that does nothing has to say why BEFORE it is pressed. */}
            <button
              type="submit"
              aria-label="Send comment"
              title="Send comment"
              aria-disabled={composeDraft.trim() === ''}
              className={cn(ICON_VERB_CLASS, 'aria-disabled:opacity-40')}
            >
              <SendHorizontal aria-hidden="true" className="size-4" />
            </button>
          </div>
        </form>
      ) : null}

      {shown.length === 0 ? (
        <p data-testid="comments-panel-empty" className="px-2 py-4 text-xs text-neutral-500">
          {/* Which filter emptied the list is the useful half. A document
              with only resolved conversations is not a document with no
              comments, and one blank state for both would say it was. */}
          {threads.length === 0
            ? 'No comments yet.'
            : filter === 'open'
              ? 'No open conversations.'
              : 'No resolved conversations.'}
        </p>
      ) : (
        <ul ref={listRef} className="flex flex-col gap-1">
          {shown.map((thread) => {
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
                key={thread.id}
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
                    className={cn(
                      'min-w-0 flex-1 rounded px-2 py-1.5 text-left text-xs hover:bg-accent',
                      TOGGLE_STATE_CLASS,
                    )}
                  >
                    <span className="comment-row-subject line-clamp-2 text-neutral-800 dark:text-neutral-200">
                      {excerptOf(thread)}
                    </span>
                    <span className="comment-row-meta mt-0.5 flex items-center gap-2 text-[11px] text-neutral-500">
                      {anchorLabel(thread.anchor) === undefined ? null : (
                        <span data-testid={`thread-about-${thread.id}`}>
                          {anchorLabel(thread.anchor)}
                        </span>
                      )}
                      <MessageBy message={thread.messages[0]} />
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
                  <div id={`thread-${thread.id}`} className="mt-1 flex flex-col gap-2 pl-2">
                    {/* Only Edit here now. Resolve moved ONTO the status dot
                        on the row above — the state and the verb became one
                        object, and it is reachable without opening the
                        conversation first. */}
                    {onEditMessage === undefined || editing?.threadId === thread.id ? null : (
                      <div className="flex items-center">
                        <button
                          type="button"
                          aria-label="Edit comment"
                          title="Edit comment"
                          onClick={() =>
                            setEditing({
                              threadId: thread.id,
                              body: thread.messages[0]?.body ?? '',
                            })
                          }
                          className={ICON_VERB_CLASS}
                        >
                          <Pencil aria-hidden="true" className="size-4" />
                        </button>
                      </div>
                    )}
                    {onEditMessage !== undefined && editing?.threadId === thread.id ? (
                      <form
                        data-testid="comment-edit"
                        className="flex flex-col gap-1"
                        onSubmit={(event) => {
                          event.preventDefault()
                          const body = editing.body.trim()
                          const opening = thread.messages[0]
                          // An emptied subject is a cancel, not a blank
                          // message: the schema refuses an empty body.
                          if (body !== '' && opening !== undefined && body !== opening.body) {
                            onEditMessage(thread.id, opening.id, body)
                          }
                          setEditing(null)
                        }}
                      >
                        <textarea
                          ref={editRef}
                          aria-label="Edit comment text"
                          value={editing.body}
                          onChange={(event) =>
                            setEditing({ threadId: thread.id, body: event.target.value })
                          }
                          rows={2}
                          className="w-full resize-y rounded border bg-background px-2 py-1 text-xs"
                        />
                        {/* No Cancel button: Escape already leaves the edit,
                            and an X here would be the third meaning of that
                            glyph in one panel. */}
                        <div className="flex justify-end">
                          <button
                            type="submit"
                            aria-label="Save"
                            title="Save"
                            aria-disabled={editing.body.trim() === ''}
                            className={cn(ICON_VERB_CLASS, 'aria-disabled:opacity-40')}
                          >
                            <Check aria-hidden="true" className="size-4" />
                          </button>
                        </div>
                      </form>
                    ) : null}
                    {/* The opening message as WRITTEN, when the row's
                        summary of it dropped something — see
                        `excerptLosesSomething`. */}
                    {excerptLosesSomething(thread.messages[0]?.body ?? '') ? (
                      <CommentBody
                        body={thread.messages[0]?.body ?? ''}
                        compact
                        className="text-neutral-800 dark:text-neutral-200"
                      />
                    ) : null}

                    <ThreadReplies thread={thread} compact />

                    {onReply === undefined ? null : (
                      // Keyed by thread, which is what makes the draft belong
                      // to the conversation it was typed into: moving to
                      // another one mounts a fresh box instead of carrying
                      // half a sentence across.
                      <ReplyComposer
                        key={thread.id}
                        compact
                        onReply={(body) => onReply(thread.id, body)}
                      />
                    )}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
