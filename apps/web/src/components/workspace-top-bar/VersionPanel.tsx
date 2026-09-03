import type { ReactNode, Ref } from 'react'
import VersionTimeline, { type VersionTimelineCapabilities } from '@/components/VersionTimeline'
import type { PastDocument } from '@/lib/versions-backend'

interface VersionPanelProps {
  panelRef?: Ref<HTMLDivElement>
  workspaceId: string
  path: string
  capabilities?: VersionTimelineCapabilities
  onRestored?: () => void
  refreshSignal?: number
  onPreview?: (past: PastDocument | null) => void
  headerActions?: ReactNode
}

/**
 * The document's history, as a COLUMN of the editor row.
 *
 * It was a 340x480 popover hanging off the spatial editor's dock, which cost
 * it two things: a markdown document has no dock to hang it from, and a past
 * state cannot be previewed inside a box that size. As a column it is as tall
 * as the editor beside it and belongs to the document rather than to one
 * editor — which is what lets both kinds reach the same history.
 *
 * Position-agnostic within that: the shell's `aside` slot owns where the
 * column sits, this component owns the surface.
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
  return (
    <div
      ref={panelRef}
      data-testid="history-panel"
      className="flex w-[300px] max-w-[calc(100vw-1.5rem)] min-h-0 shrink-0 flex-col border-l bg-background"
    >
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
  )
}
