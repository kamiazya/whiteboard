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

/**
 * A problem is shown, and announced, only once it has persisted this long.
 * One that resolves itself is not something a person can act on, and a live
 * region cannot take an announcement back — a refusal that clears within the
 * grace would otherwise be heard as lost data. Longer than the saving wait,
 * since this one is spoken. A problem already showing is replaced by another
 * at once, and a page that opens on one shows it at once.
 */
export const PROBLEM_SHOWN_AFTER_MS = 1_500

function useDisplayed(indicator: SaveIndicator): SaveIndicator {
  const [held, setHeld] = useState(indicator)
  const delayMs =
    indicator.tone === 'saving'
      ? SAVING_SHOWN_AFTER_MS
      : indicator.tone === 'problem' && held.tone !== 'problem'
        ? PROBLEM_SHOWN_AFTER_MS
        : null
  useEffect(() => {
    if (delayMs === null) {
      setHeld(indicator)
      return
    }
    const timer = setTimeout(() => setHeld(indicator), delayMs)
    return () => clearTimeout(timer)
  }, [indicator, delayMs])
  // The state shown before is what is held while a short write is pending or a
  // problem is still inside its grace; any other transition is shown on the
  // render it arrives, not an effect later.
  return delayMs === null ? indicator : held
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
 * has lasted past its grace — the saved/saving rhythm is never announced.
 */
export function SaveStatus({ indicator }: { indicator: SaveIndicator }) {
  const shown = useDisplayed(indicator)
  const offline = shown.tone === 'problem' && shown.label.startsWith('Offline')
  const head = shown.label.split(' — ')[0] ?? shown.label
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
      {/* A bare icon below sm reads as a button to confirm, so the head word
          stays beside it; the full sentence is for sm and up and for assistive
          tech. Saved and Saving have no longer sentence to hide. */}
      {head === shown.label ? (
        <span data-testid="save-status-word">{shown.label}</span>
      ) : (
        <>
          <span aria-hidden="true" data-testid="save-status-short" className="sm:hidden">
            {head}
          </span>
          <span className="sr-only sm:not-sr-only">{shown.label}</span>
        </>
      )}
      <span role="status" className="sr-only">
        {shown.tone === 'problem' ? shown.label : ''}
      </span>
    </span>
  )
}
