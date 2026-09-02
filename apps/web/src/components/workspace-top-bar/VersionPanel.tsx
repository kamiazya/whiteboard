import type { ReactNode, Ref } from 'react'
import VersionTimeline, { type VersionTimelineCapabilities } from '@/components/VersionTimeline'

interface VersionPanelProps {
  panelRef: Ref<HTMLDivElement>
  workspaceId: string
  path: string
  capabilities?: VersionTimelineCapabilities
  onRestored?: () => void
  refreshSignal?: number
  versionPanelExtra?: ReactNode
}

// Version history panel surface. Position-agnostic: the mount site (the
// canvas history cluster) owns placement; this component owns the surface.
export function VersionPanel({
  panelRef,
  workspaceId,
  path,
  capabilities,
  onRestored,
  refreshSignal,
  versionPanelExtra,
}: VersionPanelProps) {
  return (
    <div
      ref={panelRef}
      className="w-[340px] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border bg-background shadow-lg"
    >
      <div className="flex h-[480px] min-h-0 flex-col">
        <VersionTimeline
          workspaceId={workspaceId}
          path={path}
          capabilities={capabilities}
          onRestored={onRestored}
          refreshSignal={refreshSignal}
        />
        {versionPanelExtra}
      </div>
    </div>
  )
}
