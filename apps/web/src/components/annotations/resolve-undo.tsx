import type { CommentThreadStatus } from '@kamiazya/whiteboard-model'
import { type Ref, useCallback, useEffect, useRef, useState } from 'react'

/** Long enough to notice a wrong press and reach the Undo. */
const UNDO_WINDOW_MS = 6000

interface Offer {
  readonly threadId: string
  readonly to: CommentThreadStatus
}

/** The status change the reader can still take back, for a few seconds. */
export function useResolveUndo(): {
  readonly offer: Offer | null
  readonly offerUndo: (next: Offer | null) => void
} {
  const [offer, setOffer] = useState<Offer | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const offerUndo = useCallback((next: Offer | null) => {
    window.clearTimeout(timer.current)
    setOffer(next)
    if (next !== null) timer.current = window.setTimeout(() => setOffer(null), UNDO_WINDOW_MS)
  }, [])
  return { offer, offerUndo }
}

export function ResolveUndoNotice({
  to,
  onUndo,
  undoRef,
}: {
  readonly to: CommentThreadStatus
  readonly onUndo: () => void
  /** The Undo button, so the panel can hand it the focus the pressed verb just lost. */
  readonly undoRef?: Ref<HTMLButtonElement>
}) {
  return (
    <div
      data-testid="comments-panel-undo"
      className="flex items-center gap-1 rounded bg-muted px-2 text-xs"
    >
      <span>{to === 'resolved' ? 'Resolved' : 'Reopened'}</span>
      <span aria-hidden="true">&middot;</span>
      <button
        ref={undoRef}
        type="button"
        aria-label={to === 'resolved' ? 'Undo resolve' : 'Undo reopen'}
        onClick={onUndo}
        className="min-h-11 rounded px-1 font-medium text-foreground underline underline-offset-2 hover:bg-accent"
      >
        Undo
      </button>
    </div>
  )
}

/** Whether the keyboard focus is on a conversation's control or on the Undo notice. */
export function focusIsInRail(): boolean {
  const held = document.activeElement
  return (
    held instanceof HTMLElement &&
    (held.closest('[data-thread-id]') !== null ||
      held.closest('[data-testid="comments-panel-undo"]') !== null)
  )
}
