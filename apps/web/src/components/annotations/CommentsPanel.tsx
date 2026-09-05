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
import type { AnnotationAnchor, CommentThread } from '@kamiazya/whiteboard-model'
import { MessageSquarePlus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { TOGGLE_STATE_CLASS } from '@/components/ui/dock-button'
import { cn } from '@/lib/utils'
import { MessageBy } from './message-meta.js'
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
   * Which conversation is open, when the HOST owns it — so the editor's
   * in-place projection and this list agree on the answer, and a press on
   * a gutter marker opens the same thread here. Absent, the panel keeps
   * its own.
   */
  readonly openThreadId?: string | null
  readonly onOpenThreadChange?: (threadId: string | null) => void
  /**
   * A conversation about to be opened — the host has an anchor (a passage
   * the reader selected) and needs the opening message. Shown above the
   * list as a composer labelled with what it is about; the host writes the
   * thread on submit and clears this on submit or cancel.
   */
  readonly draft?: {
    /**
     * What the conversation is about, as the reader would recognise it (the
     * quoted passage). Absent, the draft is about the document itself.
     */
    readonly about?: string
    readonly onSubmit: (body: string) => void
    readonly onCancel: () => void
  }
  /**
   * Opens a draft about the document as a whole — the one anchor with no
   * place on any surface, so this list is where it is started as well as
   * read. Absent on a host with no write path, like `onReply`.
   */
  readonly onDraftDocument?: () => void
  /**
   * Appends a message to a conversation. Absent hides the reply box entirely
   * rather than showing a control that silently does nothing — a host with no
   * write path (a read-only view, or one with no session yet) has no reply to
   * offer, and saying so by omission is the honest form.
   */
  readonly onReply?: (threadId: string, body: string) => void
}

function matches(thread: CommentThread, filter: ThreadFilter): boolean {
  return filter === 'all' || thread.status === filter
}

/**
 * The first message is the conversation's subject — replies are read by
 * opening it, not by scanning the list.
 */
function excerptOf(thread: CommentThread): string {
  return thread.messages[0]?.body ?? ''
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
  openThreadId: controlledOpenThreadId,
  onOpenThreadChange,
  draft,
  onDraftDocument,
}: CommentsPanelProps) {
  const [filter, setFilter] = useState<ThreadFilter>('open')
  // At most one conversation is open at a time. A panel of simultaneously
  // expanded threads is a wall of text with no shape; reading one and
  // replying to it is the act this surface serves.
  const [ownOpenThreadId, setOwnOpenThreadId] = useState<string | null>(null)
  const openThreadId =
    controlledOpenThreadId === undefined ? ownOpenThreadId : controlledOpenThreadId
  const sectionRef = useRef<HTMLElement | null>(null)
  // A conversation opened from OUTSIDE (a gutter marker, a bubble) may sit
  // under the filter that hides it or below the fold; it is shown under All
  // and scrolled to, since a press that opens nothing visible reads as dead.
  useEffect(() => {
    if (openThreadId === null) return
    const thread = threads.find((entry) => entry.id === openThreadId)
    if (thread === undefined) return
    setFilter((current) => (matches(thread, current) ? current : 'all'))
    const row = Array.from(sectionRef.current?.querySelectorAll('[aria-controls]') ?? []).find(
      (el) => el.getAttribute('aria-controls') === `thread-${openThreadId}`,
    )
    // Optional: jsdom has no layout to scroll.
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [openThreadId, threads])
  const shown = useMemo(() => threads.filter((t) => matches(t, filter)), [threads, filter])

  function toggle(thread: CommentThread): void {
    const next = openThreadId === thread.id ? null : thread.id
    setOwnOpenThreadId(next)
    onOpenThreadChange?.(next)
    onSelect?.(thread)
  }

  return (
    <section
      ref={sectionRef}
      aria-label="Comments"
      data-testid="comments-panel"
      className="flex flex-col gap-2"
    >
      {draft !== undefined ? (
        <div
          data-testid="comment-draft"
          className="flex flex-col gap-1 rounded border border-(--comment-accent) p-2"
        >
          <p className="text-xs text-muted-foreground">
            {draft.about === undefined ? (
              <>
                Comment on{' '}
                <span className="text-foreground" data-testid="comment-draft-about">
                  the whole document
                </span>
              </>
            ) : (
              <>
                Comment on{' '}
                <q className="text-foreground" data-testid="comment-draft-about">
                  {draft.about}
                </q>
              </>
            )}
          </p>
          <ReplyComposer compact onReply={draft.onSubmit} autoFocus />
          <button
            type="button"
            onClick={draft.onCancel}
            className="self-end text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      ) : null}
      {draft === undefined && onDraftDocument !== undefined ? (
        <button
          type="button"
          data-testid="comment-on-document"
          onClick={onDraftDocument}
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
        <ul className="flex flex-col gap-1">
          {shown.map((thread) => {
            const expanded = thread.id === openThreadId
            return (
              <li key={thread.id}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={`thread-${thread.id}`}
                  onClick={() => toggle(thread)}
                  className={cn(
                    'w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent',
                    TOGGLE_STATE_CLASS,
                  )}
                >
                  <span className="line-clamp-2 text-neutral-800 dark:text-neutral-200">
                    {excerptOf(thread)}
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-[11px] text-neutral-500">
                    {anchorLabel(thread.anchor) === undefined ? null : (
                      <span data-testid={`thread-about-${thread.id}`}>
                        {anchorLabel(thread.anchor)}
                      </span>
                    )}
                    <MessageBy message={thread.messages[0]} />
                    {thread.messages.length > 1 ? (
                      <span data-testid={`thread-message-count-${thread.id}`}>
                        {thread.messages.length} messages
                      </span>
                    ) : null}
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

                {expanded ? (
                  <div id={`thread-${thread.id}`} className="mt-1 flex flex-col gap-2 pl-2">
                    <ThreadReplies thread={thread} compact />
                    {/* Absent hides the box entirely rather than showing a
                        control that silently does nothing — a host with no
                        write path (a read-only view, or one with no session
                        yet) has no reply to offer. Keyed by thread through
                        the row, so a draft never follows the reader to the
                        next conversation. */}
                    {onReply === undefined ? null : (
                      <ReplyComposer compact onReply={(body) => onReply(thread.id, body)} />
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
