import type { AnnotationAnchor, CommentThread } from '@kamiazya/whiteboard-model'

/**
 * Which conversations the reader is looking at. **Per-user view state, never
 * written to the document** (ADR-0025 decision 2's surviving half): one
 * person's filter must not change what another sees.
 */
export type ThreadFilter = 'open' | 'resolved' | 'all'

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
