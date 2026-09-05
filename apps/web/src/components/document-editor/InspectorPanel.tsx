/**
 * The vessel every inspector panel stands in — the one `aside` of
 * `DocumentPageShell`, showing whichever panel the page's inspector slot
 * holds (`lib/inspector.ts`).
 *
 * A COLUMN of the editor row where there is width for one, a bottom sheet
 * over the editor under 768px. The history panel arrived at that shape
 * first: a 300px column beside a 375px phone editor is two unusable halves,
 * so under 768px the same panel is a sheet anchored to the bottom edge, out
 * of flow, with two stages. The PEEK stage is the load-bearing one —
 * looking at a past version draws it in place of the editor, and on a phone
 * that is only worth anything if the sheet leaves the document above it
 * visible while you choose. The FULL stage is for reading a long list, where
 * the document behind it has nothing to say. The comments rail then copied
 * the shape verbatim; this is the copy folded back into one place, so a
 * third and fourth panel could not drift from it.
 *
 * Position-agnostic within that: the shell's `aside` slot owns where the
 * panel sits, and the sheet positions against the row the shell wraps.
 */

import { ChevronUp, X } from 'lucide-react'
import type { ReactNode, Ref } from 'react'
import { useState } from 'react'
import { INSPECTOR_CHROME, type InspectorKind } from '../../lib/inspector.js'
import { cn } from '../../lib/utils.js'
import { HEADER_BUTTON_CLASS } from '../ui/header-button.js'

export function InspectorPanel({
  kind,
  onClose,
  panelRef,
  children,
}: {
  readonly kind: InspectorKind
  /** Releases the slot — the sheet's own way out, since its opener is up in the header. */
  readonly onClose: () => void
  readonly panelRef?: Ref<HTMLDivElement>
  readonly children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const { label, testId } = INSPECTOR_CHROME[kind]
  const lower = label.toLowerCase()
  return (
    <div
      ref={panelRef}
      data-testid={testId}
      data-stage={expanded ? 'full' : 'peek'}
      className={cn(
        'absolute inset-x-0 bottom-0 z-20 flex min-h-0 flex-col border-t bg-background shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.35)]',
        expanded ? 'h-full' : 'h-[45%] rounded-t-2xl',
        'md:static md:z-auto md:h-auto md:w-[300px] md:max-w-[calc(100vw-1.5rem)] md:shrink-0 md:rounded-none md:border-t-0 md:border-l md:shadow-none',
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-2 pt-1.5 md:hidden">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <button
          type="button"
          data-testid={`${kind}-stage-toggle`}
          aria-label={expanded ? `Collapse ${lower}` : `Expand ${lower}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          // The sheet's grab handle: a wide, shallow target a thumb aims at
          // the edge for, not an icon-sized one. One chevron, turned by the
          // ARIA state rather than swapped for another glyph, so the
          // announced state and the drawn one cannot disagree.
          className="flex h-6 w-16 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:[&>svg]:rotate-180"
        >
          <ChevronUp aria-hidden="true" className="size-4 transition-transform" />
        </button>
        <button
          type="button"
          aria-label={`Close ${lower}`}
          onClick={onClose}
          className={cn(HEADER_BUTTON_CLASS, 'ml-auto')}
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </div>
  )
}
