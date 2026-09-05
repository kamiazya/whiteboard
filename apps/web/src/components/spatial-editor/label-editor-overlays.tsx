import {
  edgeLabelAnchor,
  SPATIAL_THEME_FONT_FAMILY,
  SPATIAL_THEME_GEOMETRY,
} from '@kamiazya/whiteboard-canvas-render'
import type { CanvasEdge, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { editorTextFill } from '../../lib/spatial/editor-appearance.js'
import type { Point } from '../../lib/spatial/viewport.js'
import type { ResolvedTheme } from '../../lib/theme.js'
import type { reduceGesture } from './gestures.js'
import { TextNodeEditor } from './TextNodeEditor.js'

const EDGE_LABEL_EDITOR_WIDTH_PX = 160
const EDGE_LABEL_EDITOR_HEIGHT_PX = 28

/**
 * Opaque surface + label typography for the edge/group label editors. The
 * CSS reset makes form controls transparent, so without an explicit
 * background the object being edited (an edge line, the frame border)
 * shows through the draft.
 */
function labelEditorStyle(theme: ResolvedTheme) {
  return {
    background: theme === 'dark' ? 'oklch(0.145 0 0)' : '#ffffff',
    color: editorTextFill(theme),
    fontFamily: SPATIAL_THEME_FONT_FAMILY,
    fontSize: SPATIAL_THEME_GEOMETRY.labelFontSizePx,
  }
}

type ApplyResult = (result: ReturnType<typeof reduceGesture>) => void

/** The in-place editor for an edge's label, opened over the drawn line's
 * midpoint — `edgePaths` is already the DRAWN (flattened) line, so the
 * shared anchor needs no second rounding pass here. */
export function EdgeLabelEditorOverlay({
  editId,
  canvas,
  edgePaths,
  zoom,
  theme,
  applyResult,
  onClose,
}: {
  readonly editId: string
  readonly canvas: SpatialCanvas
  readonly edgePaths: readonly { readonly id: string; readonly path: readonly Point[] }[]
  readonly zoom: number
  readonly theme: ResolvedTheme
  readonly applyResult: ApplyResult
  readonly onClose: () => void
}) {
  const edge: CanvasEdge | undefined = canvas.edges.find((entry) => entry.id === editId)
  const path = edgePaths.find((entry) => entry.id === editId)?.path
  if (edge === undefined || path === undefined) return null
  const mid = edgeLabelAnchor(path)
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
      style={labelEditorStyle(theme)}
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
  zoom,
  theme,
  applyResult,
  onClose,
}: {
  readonly editId: string
  readonly canvas: SpatialCanvas
  readonly zoom: number
  readonly theme: ResolvedTheme
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
      style={labelEditorStyle(theme)}
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
