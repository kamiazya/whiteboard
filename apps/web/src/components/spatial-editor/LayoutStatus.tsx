import { LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'

/**
 * Below this a layout is not worth announcing: the worker answers an ordinary
 * board in a few frames, and a status that flashes on every edit is noise.
 */
const LAYOUT_STATUS_DELAY_MS = 300

/**
 * Says the drawn board is behind the document while a layout is in flight —
 * after a theme, routing or font change the previous scene stays on screen, so
 * without this it reads as a change that did not take.
 *
 * Always mounted: a live region that arrives already carrying its text is
 * announced inconsistently, one whose text changes is not.
 */
export function LayoutStatus({ current }: { readonly current: boolean }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (current) {
      setShown(false)
      return
    }
    const timer = setTimeout(() => setShown(true), LAYOUT_STATUS_DELAY_MS)
    return () => clearTimeout(timer)
  }, [current])
  return (
    <div aria-live="polite" data-testid="layout-status" data-editor-overlay>
      {shown && !current && (
        <div className="pointer-events-none absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-background px-3 py-1 text-muted-foreground text-xs shadow-sm">
          <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
          <span>Laying out…</span>
        </div>
      )}
    </div>
  )
}
