import { Loader2, Save } from 'lucide-react'
import type { JSX } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * Take a version, from inside the History panel.
 *
 * ⌘/Ctrl+S and the header's version dot are the other two routes to the
 * same act; a phone has neither a shortcut nor much of a target, so the
 * panel a finger opens carries one too. Both document pages mount this —
 * the keeper differs, the affordance does not.
 *
 * Icon-only, per DESIGN.md's object-action rule: the verb is a symbol, the
 * NAME lives in `aria-label`, and the explanation lives in the tooltip.
 * What a save produced is a ROW in the list right beside it, so success
 * needs no words on screen — only an announcement for a reader who cannot
 * see the row arrive. A failure produces nothing to look at, so that one
 * is drawn, as short as a label rather than as a sentence.
 *
 * `aria-disabled` rather than the native attribute: a disabled button
 * inside a Radix TooltipTrigger swallows the pointer events the tooltip
 * needs, hiding the in-flight state exactly when it is being asked about.
 */

export type SaveVersionOutcome = 'saved' | 'failed' | null

export interface SaveVersionActionProps {
  readonly saving: boolean
  readonly outcome: SaveVersionOutcome
  readonly onSave: () => void
}

export function SaveVersionAction({
  saving,
  outcome,
  onSave,
}: SaveVersionActionProps): JSX.Element {
  const label = saving ? 'Saving a version…' : 'Save version'
  return (
    <div className="flex items-center gap-1.5">
      {outcome === 'failed' && (
        <span role="alert" className="text-[11px] font-medium text-destructive">
          Save failed
        </span>
      )}
      {outcome === 'saved' && (
        <span role="status" aria-live="polite" className="sr-only">
          Version saved
        </span>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-disabled={saving}
            data-testid="save-version-action"
            onClick={() => {
              if (saving) return
              onSave()
            }}
            className={cn(
              'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors',
              'hover:bg-accent hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              saving && 'text-muted-foreground/60',
              outcome === 'failed' && 'text-destructive',
            )}
          >
            {saving ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : (
              <Save aria-hidden="true" className="size-4" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {outcome === 'failed' ? 'Save failed. Try again.' : `${label} (⌘/Ctrl+S)`}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
