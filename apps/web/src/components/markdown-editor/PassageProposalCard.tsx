/**
 * What a person decides a proposed passage on, drawn beside the words it
 * would replace (ADR-0029 decision 1, for prose).
 *
 * The canvas card and this one are the same act in two places, so they share
 * the grammar rather than each inventing one: icon verbs at
 * `ICON_VERB_CLASS`, a circled glyph for a verb that WRITES something, and
 * the accessible name carrying what the bare icon cannot.
 *
 * What differs is the subject. A canvas change is described ("Move the
 * risk"); a passage change is SHOWN — the words it would put there are the
 * whole content of the decision, and a summary of them would be a worse
 * version of the thing itself.
 */
import { CircleCheck, CircleX } from 'lucide-react'
import type { CSSProperties } from 'react'
import { ICON_VERB_CLASS } from '../ui/icon-verb.js'

export interface PassageProposalCardProps {
  /** The words the body holds there now. */
  readonly current: string
  /** The words the change would put there. */
  readonly proposed: string
  /**
   * Whether the passage stopped saying what the change assumed. Decision 5:
   * the proposal followed the document, and adopting now would replace words
   * the agent never read — which is the person's call to make, and theirs to
   * be told about.
   */
  readonly conflicted: boolean
  readonly at: { readonly x: number; readonly y: number }
  readonly onDecide: (decision: 'adopted' | 'dismissed') => void
  readonly onClose: () => void
}

export function PassageProposalCard({
  current,
  proposed,
  conflicted,
  at,
  onDecide,
  onClose,
}: PassageProposalCardProps) {
  const style: CSSProperties = { left: at.x, top: at.y }
  return (
    <div
      className="absolute z-30 w-72 max-w-[min(18rem,calc(100vw-2rem))] rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md"
      style={style}
      role="dialog"
      aria-label="Proposed change to this passage"
      data-testid="passage-proposal-card"
    >
      {conflicted ? (
        <p className="mb-1.5 text-xs text-amber-700 dark:text-amber-400">
          These words changed after this was proposed.
        </p>
      ) : null}
      <div className="mb-2 space-y-1 text-sm">
        <p className="whitespace-pre-wrap break-words text-muted-foreground line-through">
          {current}
        </p>
        <p className="whitespace-pre-wrap break-words">{proposed}</p>
      </div>
      <div className="flex items-center justify-end gap-1">
        {/* Dismiss first, Adopt last: the rightmost is the one a thumb
            reaches without looking, and adopting is the act that writes. */}
        <button
          type="button"
          className={ICON_VERB_CLASS}
          aria-label="Dismiss this change"
          title="Dismiss this change"
          onClick={() => onDecide('dismissed')}
        >
          <CircleX aria-hidden="true" className="size-5" />
        </button>
        <button
          type="button"
          className={ICON_VERB_CLASS}
          aria-label="Adopt this change"
          title="Adopt this change"
          onClick={() => onDecide('adopted')}
        >
          <CircleCheck aria-hidden="true" className="size-5" />
        </button>
      </div>
      {/* A bare × is chrome, not a verb — it decides nothing about the
          passage, it puts the card away. */}
      <button
        type="button"
        className="absolute right-1 top-1 grid size-6 place-items-center rounded text-muted-foreground hover:text-foreground"
        aria-label="Close"
        onClick={onClose}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  )
}
