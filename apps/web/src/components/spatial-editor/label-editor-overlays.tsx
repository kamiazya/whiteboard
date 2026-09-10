import type { SpatialPalette } from '@kamiazya/whiteboard-canvas-render'
import {
  edgeLabelPlacement,
  labelObstacles,
  SPATIAL_THEME_GEOMETRY,
} from '@kamiazya/whiteboard-canvas-render'
import type { CanvasEdge, SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { Point } from '../../lib/spatial/viewport.js'
import type { reduceGesture } from './gestures.js'
import { TextNodeEditor } from './TextNodeEditor.js'

const EDGE_LABEL_EDITOR_WIDTH_PX = 160
const EDGE_LABEL_EDITOR_HEIGHT_PX = 28

/**
 * Opaque surface + label typography for the edge/group label editors. The
 * CSS reset makes form controls transparent, so without an explicit
 * background the object being edited (an edge line, the frame border)
 * shows through the draft — so it takes the board's own paper and ink
 * (ADR-0030), which is what the label becomes on commit.
 */
function labelEditorStyle(palette: SpatialPalette, fontFamily: string) {
  return {
    background: palette.surface,
    color: palette.labelFill,
    // The family the scene declares under the canvas's look — the theme's
    // where its face is held, the bundled one otherwise — so the draft and
    // the label it becomes are written in one hand.
    fontFamily,
    fontSize: SPATIAL_THEME_GEOMETRY.labelFontSizePx,
  }
}

type ApplyResult = (result: ReturnType<typeof reduceGesture>) => void

/** The in-place editor for an edge's label, opened where the label sits —
 * the drawn line's midpoint, or beside it when a box is in the way, from the
 * same producer the renderer places the label with. `edgePaths` is already
 * the DRAWN (flattened) line, so the shared anchor needs no second rounding
 * pass here. */
export function EdgeLabelEditorOverlay({
  editId,
  canvas,
  fontFamily,
  edgePaths,
  zoom,
  palette,
  applyResult,
  onClose,
}: {
  readonly editId: string
  readonly canvas: SpatialCanvas
  readonly fontFamily: string
  readonly edgePaths: readonly { readonly id: string; readonly path: readonly Point[] }[]
  readonly zoom: number
  /** The palette the board is drawn in, so the draft matches the label it becomes. */
  readonly palette: SpatialPalette
  readonly applyResult: ApplyResult
  readonly onClose: () => void
}) {
  const edge: CanvasEdge | undefined = canvas.edges.find((entry) => entry.id === editId)
  const path = edgePaths.find((entry) => entry.id === editId)?.path
  if (edge === undefined || path === undefined) return null
  const mid = edgeLabelPlacement(
    path,
    { w: EDGE_LABEL_EDITOR_WIDTH_PX, h: EDGE_LABEL_EDITOR_HEIGHT_PX },
    labelObstacles(canvas.nodes),
  )
  if (mid === undefined) return null
  return (
    <TextNodeEditor
      exitHintScale={1 / zoom}
      box={{
        x: mid.x - EDGE_LABEL_EDITOR_WIDTH_PX / 2,
        y: mid.y - EDGE_LABEL_EDITOR_HEIGHT_PX / 2,
        width: EDGE_LABEL_EDITOR_WIDTH_PX,
        height: EDGE_LABEL_EDITOR_HEIGHT_PX,
      }}
      initialText={edge.label ?? ''}
      testId="edge-label-editor"
      style={labelEditorStyle(palette, fontFamily)}
      onCommit={(label) => {
        applyResult({
          state: { kind: 'idle' },
          commands: [{ kind: 'set-edge-label', id: edge.id, label: label.trim() } as const],
        })
        onClose()
      }}
      onCancel={onClose}
    />
  )
}

/** The in-place editor for a group's label. The label renders OUTSIDE,
 * above the frame (container convention) — the editor sits on that band. */
export function GroupLabelEditorOverlay({
  editId,
  canvas,
  fontFamily,
  zoom,
  palette,
  applyResult,
  onClose,
}: {
  readonly editId: string
  readonly canvas: SpatialCanvas
  readonly fontFamily: string
  readonly zoom: number
  /** The palette the board is drawn in, so the draft matches the label it becomes. */
  readonly palette: SpatialPalette
  readonly applyResult: ApplyResult
  readonly onClose: () => void
}) {
  const group = canvas.nodes.find((entry) => entry.id === editId)
  if (group === undefined || group.type !== 'group') return null
  return (
    <TextNodeEditor
      exitHintScale={1 / zoom}
      box={{ x: group.x, y: group.y - 44, width: group.width, height: 40 }}
      initialText={group.label ?? ''}
      testId="group-label-editor"
      style={labelEditorStyle(palette, fontFamily)}
      onCommit={(label) => {
        applyResult({
          state: { kind: 'idle' },
          commands: [{ kind: 'set-group-label', id: group.id, label: label.trim() } as const],
        })
        onClose()
      }}
      onCancel={onClose}
    />
  )
}
