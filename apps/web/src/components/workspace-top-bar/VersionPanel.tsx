import type { ReactNode, Ref } from 'react'
import VersionTimeline, { type VersionPreviewSession } from '../../components/VersionTimeline.js'
import { InspectorPanel } from '../document-editor/InspectorPanel.js'

interface VersionPanelProps {
  panelRef?: Ref<HTMLDivElement>
  workspaceId: string
  path: string
  onRestored?: () => void
  refreshSignal?: number
  onPreview?: (session: VersionPreviewSession | null) => void
  headerActions?: ReactNode
  onClose: () => void
}

/**
 * The document's history in the inspector's vessel (`InspectorPanel`).
 *
 * It was a 340x480 popover hanging off the spatial editor's dock, which cost
 * it two things: a markdown document has no dock to hang it from, and a past
 * state cannot be previewed inside a box that size. As a column it is as tall
 * as the editor beside it and belongs to the document rather than to one
 * editor — which is what lets both kinds reach the same history.
 */
export function VersionPanel({
  panelRef,
  workspaceId,
  path,
  onRestored,
  refreshSignal,
  onPreview,
  headerActions,
  onClose,
}: VersionPanelProps) {
  return (
    <InspectorPanel
      kind="history"
      onClose={onClose}
      {...(panelRef === undefined ? {} : { panelRef })}
    >
      <VersionTimeline
        workspaceId={workspaceId}
        path={path}
        onRestored={onRestored}
        refreshSignal={refreshSignal}
        onPreview={onPreview}
        headerActions={headerActions}
      />
    </InspectorPanel>
  )
}
