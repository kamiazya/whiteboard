import { BookmarkPlus, Loader2 } from 'lucide-react'
import { type JSX, useEffect, useRef, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js'
import { cn } from '../../lib/utils.js'

/**
 * Mark the current state as a point worth coming back to.
 *
 * This replaces the header's save dot, and the difference is not cosmetic.
 * The dot meant "you have edits no version holds yet" and pressing it took
 * a version; once checkpoints are taken automatically that state no longer
 * exists and there is nothing to press it for. What is left is a different
 * act — naming a point — and it belongs beside the list of points rather
 * than in the document's chrome.
 *
 * The NAME is the whole value, which is why this opens a field instead of
 * saving on the press: rows are titled by their label, or by their time
 * when they have none, so an unnamed bookmark is indistinguishable from the
 * automatic checkpoint above it. An empty field is refused for that reason
 * rather than silently accepted.
 *
 * Icon-only, per DESIGN.md's object-action rule. `aria-disabled` rather
 * than the native attribute: a disabled button inside a Radix TooltipTrigger
 * swallows the pointer events the tooltip needs.
 */

export type SaveVersionOutcome = 'saved' | 'failed' | null

export interface BookmarkActionProps {
  readonly saving: boolean
  readonly outcome: SaveVersionOutcome
  /**
   * Bumped by the page to open the field from somewhere else — the ⌘/Ctrl+S
   * shortcut, which no longer saves anything by itself. A counter rather
   * than a boolean so a second press re-opens it after a cancel.
   */
  readonly armed?: number
  readonly onSave: (label: string) => void
}

export function BookmarkAction({
  saving,
  outcome,
  armed = 0,
  onSave,
}: BookmarkActionProps): JSX.Element {
  const [naming, setNaming] = useState(false)
  const [draft, setDraft] = useState('')
  const fieldRef = useRef<HTMLInputElement | null>(null)
  // Seeded at 0, NOT at the incoming value: the shortcut opens the panel and
  // bumps the counter in one go, so this component MOUNTS already armed. A
  // ref seeded from the prop would read that as "no change" and swallow the
  // very press that brought the panel up.
  const lastArmRef = useRef(0)

  useEffect(() => {
    if (armed === lastArmRef.current) return
    lastArmRef.current = armed
    setNaming(true)
  }, [armed])

  useEffect(() => {
    if (naming) fieldRef.current?.focus()
  }, [naming])

  const commit = (): void => {
    const label = draft.trim()
    if (label === '') return
    setNaming(false)
    setDraft('')
    onSave(label)
  }

  if (naming) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          ref={fieldRef}
          type="text"
          value={draft}
          aria-label="Name this point"
          placeholder="Name this point"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setNaming(false)
              setDraft('')
            }
          }}
          className="h-6 w-40 rounded-md border bg-background px-2 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>
    )
  }

  const label = saving ? 'Saving a bookmark…' : 'Bookmark this point'
  return (
    <div className="flex items-center gap-1.5">
      {outcome === 'failed' && (
        <span role="alert" className="text-[11px] font-medium text-destructive">
          Save failed
        </span>
      )}
      {/* Mounted from the start and given its words later: a role="status"
          that ARRIVES carrying its message is announced inconsistently
          (polite-live-region.test.ts holds the rule). */}
      <span role="status" aria-live="polite" className="sr-only">
        {outcome === 'saved' ? 'Bookmark saved' : ''}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-disabled={saving}
            data-testid="bookmark-action"
            onClick={() => {
              if (saving) return
              setNaming(true)
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
              <BookmarkPlus aria-hidden="true" className="size-4" />
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
