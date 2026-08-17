/**
 * Transient status chip for a pending cut. It announces the hold (the veil
 * alone does not say what state the canvas is in) and carries the one
 * explicit exit that works everywhere — touch has no Escape key. Floats
 * above the dock rather than joining its flex row: the dock is the FIXED
 * creation strip, and this chip exists only while a cut is pending, the
 * same transient tier as a toast.
 */
import { Scissors, X } from 'lucide-react'

export interface PendingCutChipProps {
  readonly count: number
  /** Coarse pointers get the tap-to-place hint; mice place via paste. */
  readonly coarse: boolean
  readonly onCancel: () => void
}

export function PendingCutChip({ count, coarse, onCancel }: PendingCutChipProps) {
  return (
    <div
      data-testid="pending-cut-chip"
      data-editor-overlay
      className="absolute bottom-20 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-sm shadow-lg"
    >
      <Scissors aria-hidden="true" className="size-3.5 text-muted-foreground" />
      <span>
        {count} held{coarse ? ' — tap to place' : ''}
      </span>
      <button
        type="button"
        aria-label="Cancel cut"
        className="flex size-6 items-center justify-center rounded-full hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
        onClick={onCancel}
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  )
}
