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
import { MARKDOWN_MAX_CHARS, type Proposal } from '@kamiazya/whiteboard-model'
import { CircleCheck, CircleX } from 'lucide-react'
import { useState } from 'react'
import { type AdoptionRefusal, adoptionRefusal } from '../../lib/apply-adopted-passages.js'
import { ProposalAuthor } from '../proposals/ProposalAuthor.js'
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
  /** Who proposed it, when the proposal says. */
  readonly author?: Proposal['author']
  /** How long the whole body is now, so adopting can be held to the size limit. */
  readonly bodyLength: number
  readonly at: { readonly x: number; readonly y: number }
  readonly onDecide: (decision: 'adopted' | 'dismissed') => void
  readonly onClose: () => void
}

export function PassageProposalCard({
  current,
  proposed,
  conflicted,
  author,
  bodyLength,
  at,
  onDecide,
  onClose,
}: PassageProposalCardProps) {
  const adopt = useAdoptWithinLimit(bodyLength, current, proposed, onDecide)
  return (
    <div
      className="absolute z-30 w-72 max-w-[min(18rem,calc(100vw-2rem))] rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md"
      style={{ left: at.x, top: at.y }}
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
      <ProposalAuthor author={author} className="mb-1 block text-xs text-muted-foreground" />
      {adopt.refused === undefined ? null : <LimitNotice refusal={adopt.refused} />}
      <div className="flex items-center justify-end gap-1">
        {/* Dismiss first, Adopt last: the rightmost is the one a thumb
            reaches without looking, and adopting is the act that writes. */}
        <VerbButton label="Dismiss this change" onSelect={() => onDecide('dismissed')}>
          <CircleX aria-hidden="true" className="size-5" />
        </VerbButton>
        <VerbButton label="Adopt this change" onSelect={adopt.press}>
          <CircleCheck aria-hidden="true" className="size-5" />
        </VerbButton>
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

function VerbButton({
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
      className={ICON_VERB_CLASS}
      aria-label={label}
      title={label}
      onClick={onSelect}
    >
      {children}
    </button>
  )
}

/**
 * Adopt, unless the body it would leave is one the keepers refuse — then
 * nothing is decided and the card says why, so the change stays open to
 * dismiss or to keep while the document is split. Judged on the body as it
 * is at the press, by the rule the write path applies again at commit.
 *
 * The press is remembered for the passage it was made on, since one card is
 * reused as the person moves between passages.
 */
function useAdoptWithinLimit(
  bodyLength: number,
  current: string,
  proposed: string,
  onDecide: (decision: 'adopted') => void,
): { readonly refused: AdoptionRefusal | undefined; readonly press: () => void } {
  const subject = `${current}\u0000${proposed}`
  const [pressedOn, setPressedOn] = useState<string | null>(null)
  const refusal = adoptionRefusal(bodyLength, bodyLength - current.length + proposed.length)
  return {
    refused: pressedOn === subject ? refusal : undefined,
    press: () => (refusal === undefined ? onDecide('adopted') : setPressedOn(subject)),
  }
}

// en-US explicitly: the editor's own size notice counts the same way, so the
// two refusals of one limit read alike whatever the browser's locale.
const COUNT = new Intl.NumberFormat('en-US')

function LimitNotice({ refusal }: { readonly refusal: AdoptionRefusal }) {
  return (
    <p role="status" className="mb-1.5 text-xs text-destructive">
      Not adopted: this would make the document {COUNT.format(refusal.length)} characters long, past
      the {COUNT.format(MARKDOWN_MAX_CHARS)}-character limit. Split the content across documents.
    </p>
  )
}
