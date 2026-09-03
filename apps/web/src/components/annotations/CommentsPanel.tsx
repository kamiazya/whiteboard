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
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { useMemo, useState } from 'react'

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

export function CommentsPanel({ threads, resolveAnchor, onSelect }: CommentsPanelProps) {
  const [filter, setFilter] = useState<ThreadFilter>('open')
  const shown = useMemo(() => threads.filter((t) => matches(t, filter)), [threads, filter])

  return (
    <section aria-label="Comments" data-testid="comments-panel" className="flex flex-col gap-2">
      <fieldset aria-label="Filter comments" className="flex gap-1 border-0 p-0">
        {FILTERS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            className={
              filter === value
                ? 'rounded px-2 py-1 text-xs font-medium bg-neutral-200 dark:bg-neutral-700'
                : 'rounded px-2 py-1 text-xs text-neutral-600 dark:text-neutral-400'
            }
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
          {shown.map((thread) => (
            <li key={thread.id}>
              <button
                type="button"
                onClick={() => onSelect?.(thread)}
                className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <span className="line-clamp-2 text-neutral-800 dark:text-neutral-200">
                  {excerptOf(thread)}
                </span>
                <span className="mt-0.5 flex items-center gap-2 text-[11px] text-neutral-500">
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
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
