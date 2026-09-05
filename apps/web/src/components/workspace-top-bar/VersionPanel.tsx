import { ChevronDown, ChevronUp } from 'lucide-react'
import { type ReactNode, type Ref, useState } from 'react'
import VersionTimeline, {
  type VersionPreviewSession,
  type VersionTimelineCapabilities,
} from '../../components/VersionTimeline.js'
import { cn } from '../../lib/utils.js'

interface VersionPanelProps {
  panelRef?: Ref<HTMLDivElement>
  workspaceId: string
  path: string
  capabilities?: VersionTimelineCapabilities
  onRestored?: () => void
  refreshSignal?: number
  onPreview?: (session: VersionPreviewSession | null) => void
  headerActions?: ReactNode
}

/**
 * The document's history: a COLUMN of the editor row where there is width
 * for one, a bottom sheet where there is not.
 *
 * It was a 340x480 popover hanging off the spatial editor's dock, which cost
 * it two things: a markdown document has no dock to hang it from, and a past
 * state cannot be previewed inside a box that size. As a column it is as tall
 * as the editor beside it and belongs to the document rather than to one
 * editor — which is what lets both kinds reach the same history.
 *
 * Under 768px a 300px column and the editor are two unusable halves, so the
 * same panel becomes a sheet anchored to the bottom edge, out of flow, with
 * two stages. The PEEK stage is the load-bearing one: looking at a past
 * version draws it in place of the editor, and on a phone that is only worth
 * anything if the sheet leaves the document above it visible while you choose.
 * The FULL stage is for reading a long history, where the document behind it
 * has nothing to say.
 *
 * Position-agnostic within that: the shell's `aside` slot owns where the
 * column sits and provides the positioned ancestor the sheet needs, this
 * component owns the surface.
 */
export function VersionPanel({
  panelRef,
  workspaceId,
  path,
  capabilities,
  onRestored,
  refreshSignal,
  onPreview,
  headerActions,
}: VersionPanelProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      ref={panelRef}
      data-testid="history-panel"
      data-stage={expanded ? 'full' : 'peek'}
      className={cn(
        'absolute inset-x-0 bottom-0 z-20 flex min-h-0 flex-col border-t bg-background shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.35)]',
        expanded ? 'h-full' : 'h-[45%] rounded-t-2xl',
        'md:static md:z-auto md:h-auto md:w-[300px] md:max-w-[calc(100vw-1.5rem)] md:shrink-0 md:rounded-none md:border-t-0 md:border-l md:shadow-none',
      )}
    >
      <div className="flex shrink-0 justify-center pt-1.5 md:hidden">
        <button
          type="button"
          data-testid="history-stage-toggle"
          aria-label={expanded ? 'Collapse history' : 'Expand history'}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          // A wide, shallow target rather than an icon-sized one: it is the
          // sheet's grab handle, and a thumb aims at the edge, not at a glyph.
          className="flex h-6 w-16 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {expanded ? (
            <ChevronDown aria-hidden="true" className="size-4" />
          ) : (
            <ChevronUp aria-hidden="true" className="size-4" />
          )}
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <VersionTimeline
          workspaceId={workspaceId}
          path={path}
          capabilities={capabilities}
          onRestored={onRestored}
          refreshSignal={refreshSignal}
          onPreview={onPreview}
          headerActions={headerActions}
        />
      </div>
    </div>
  )
}
