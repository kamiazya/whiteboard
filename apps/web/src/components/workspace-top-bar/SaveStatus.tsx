import { Check, CloudOff, Loader2, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SaveIndicator } from '../../lib/save-indicator.js'
import { cn } from '../../lib/utils.js'

/**
 * A write is pending for a few hundred milliseconds after every keystroke,
 * which asks nothing of anyone; showing it would flicker the row while someone
 * types. Saving appears only once a write has stayed pending past this.
 */
export const SAVING_SHOWN_AFTER_MS = 1_200

function useDisplayed(indicator: SaveIndicator): SaveIndicator {
  const [held, setHeld] = useState(indicator)
  const delayed = indicator.tone === 'saving'
  useEffect(() => {
    if (!delayed) {
      setHeld(indicator)
      return
    }
    const timer = setTimeout(() => setHeld(indicator), SAVING_SHOWN_AFTER_MS)
    return () => clearTimeout(timer)
  }, [indicator, delayed])
  // A stale `saved` is what is held while a short write is pending; any other
  // transition is shown on the render it arrives, not an effect later.
  return delayed ? held : indicator
}

const ICON = {
  saved: Check,
  saving: Loader2,
  problem: TriangleAlert,
} as const

/**
 * The document row's quiet answer to "are my edits safe". Muted while
 * everything is fine; amber only for a condition. The live region is mounted
 * whether or not it has anything to say and speaks only when a problem
 * arrives — the saved/saving rhythm is never announced.
 */
export function SaveStatus({ indicator }: { indicator: SaveIndicator }) {
  const shown = useDisplayed(indicator)
  const offline = indicator.tone === 'problem' && indicator.label.startsWith('Offline')
  const Icon = offline ? CloudOff : ICON[shown.tone]
  return (
    <span
      data-testid="save-status"
      data-tone={shown.tone}
      title={shown.label}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 text-xs',
        shown.tone === 'problem' ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground',
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn('size-3.5', shown.tone === 'saving' && 'animate-spin')}
      />
      {/* An icon alone below sm; the words stay in the tree for assistive tech. */}
      <span className="sr-only sm:not-sr-only">{shown.label}</span>
      <span role="status" className="sr-only">
        {indicator.tone === 'problem' ? indicator.label : ''}
      </span>
    </span>
  )
}
