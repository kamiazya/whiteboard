import type { ReactNode, Ref } from 'react'
import VersionTimeline from '@/components/VersionTimeline'

interface VersionPanelProps {
  panelRef: Ref<HTMLDivElement>
  workspaceId: string
  slug: string
  onRestored?: () => void
  refreshSignal?: number
  versionPanelExtra?: ReactNode
}

// Version history popover docked under the top-right controls.
export function VersionPanel({
  panelRef,
  workspaceId,
  slug,
  onRestored,
  refreshSignal,
  versionPanelExtra,
}: VersionPanelProps) {
  return (
    <div
      ref={panelRef}
      className="absolute right-3 top-[calc(100%+6px)] z-40 w-[340px] overflow-hidden rounded-lg border bg-background shadow-lg"
    >
      <div className="flex h-[480px] min-h-0 flex-col">
        <VersionTimeline
          workspaceId={workspaceId}
          slug={slug}
          onRestored={onRestored}
          refreshSignal={refreshSignal}
        />
        {versionPanelExtra}
      </div>
    </div>
  )
}
