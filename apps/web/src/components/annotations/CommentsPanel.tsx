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
import type { CommentMessage, CommentThread } from '@kamiazya/whiteboard-model'
import { useMemo, useState } from 'react'
import { TOGGLE_STATE_CLASS } from '@/components/ui/dock-button'
import { cn } from '@/lib/utils'

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
 * Locale- and clock-independent, deliberately: `toLocaleString` reads the
 * runner's timezone (so the same thread renders differently in CI than on a
 * laptop) and a relative "2 days ago" would make every rendering depend on
 * the wall clock. What a reader needs here is which message came first, and
 * an absolute stamp answers that without either dependency. The machine-
 * readable original rides along in `dateTime`.
 */
function stampOf(iso: string | undefined): { readonly text: string; readonly dateTime: string } {
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
function MessageBy({ message }: { readonly message: CommentMessage | undefined }) {
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

export function CommentsPanel({ threads, resolveAnchor, onSelect, onReply }: CommentsPanelProps) {
  const [filter, setFilter] = useState<ThreadFilter>('open')
  // At most one conversation is open at a time. A panel of simultaneously
  // expanded threads is a wall of text with no shape; reading one and
  // replying to it is the act this surface serves.
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const shown = useMemo(() => threads.filter((t) => matches(t, filter)), [threads, filter])

  function toggle(thread: CommentThread): void {
    setOpenThreadId((current) => (current === thread.id ? null : thread.id))
    // The draft belongs to the conversation it was typed into, so moving to
    // another one starts empty rather than carrying half a sentence across.
    setDraft('')
    onSelect?.(thread)
  }

  return (
    <section aria-label="Comments" data-testid="comments-panel" className="flex flex-col gap-2">
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
                    {/* The REPLIES, not the whole conversation over again:
                        the row above already carries the opening message,
                        which is the conversation's subject. Repeating it here
                        was the first shape and it read as the same sentence
                        twice. Replies indent under their subject instead. */}
                    {thread.messages.length > 1 ? (
                      <ol className="flex flex-col gap-2 border-l pl-2">
                        {thread.messages.slice(1).map((message) => (
                          <li key={message.id} className="flex flex-col gap-0.5">
                            <MessageBy message={message} />
                            <p className="whitespace-pre-wrap text-xs text-neutral-800 dark:text-neutral-200">
                              {message.body}
                            </p>
                          </li>
                        ))}
                      </ol>
                    ) : null}

                    {onReply === undefined ? null : (
                      <form
                        className="flex flex-col gap-1"
                        onSubmit={(event) => {
                          event.preventDefault()
                          const body = draft.trim()
                          // An empty reply is not a message. Guarded here
                          // rather than by disabling the button, so the
                          // keyboard path (Enter in the field) is covered by
                          // the same rule as the pointer one.
                          if (body === '') return
                          onReply(thread.id, body)
                          setDraft('')
                        }}
                      >
                        <textarea
                          aria-label="Reply"
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          rows={2}
                          className="w-full resize-y rounded border bg-background px-2 py-1 text-xs"
                        />
                        <button
                          type="submit"
                          className="self-end rounded border px-2 py-1 text-xs hover:bg-accent"
                        >
                          Reply
                        </button>
                      </form>
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
