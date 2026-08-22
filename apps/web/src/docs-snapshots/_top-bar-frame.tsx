// The three README canvas-tour cards (browser UI hero, agent drew, user
// annotated) all frame the same chrome: WorkspaceTopBar above a CanvasViewer
// filling the rest of a fixed-size white card. Only the framing dimensions
// and the scene differ.

import { CanvasViewer } from '@kamiazya/whiteboard-canvas-viewer'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import WorkspaceTopBar from '../components/WorkspaceTopBar.js'

const TOP_BAR_HEIGHT_PX = 48

interface TopBarFrameProps {
  testId: string
  width: number
  height: number
  scene: SpatialCanvas
}

export function TopBarFrame({ testId, width, height, scene }: TopBarFrameProps) {
  return (
    <div
      data-testid={testId}
      style={{ width: `${width}px`, height: `${height}px`, background: '#ffffff' }}
    >
      <WorkspaceTopBar
        workspaceId="ws_main"
        path="design/architecture"
        onToggleFullscreen={() => undefined}
      />
      <div style={{ height: `calc(100% - ${TOP_BAR_HEIGHT_PX}px)` }}>
        <CanvasViewer
          canvas={scene}
          width={width}
          height={height - TOP_BAR_HEIGHT_PX}
          background="#ffffff"
        />
      </div>
    </div>
  )
}
