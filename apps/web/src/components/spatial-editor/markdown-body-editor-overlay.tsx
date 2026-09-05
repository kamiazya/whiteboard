import {
  BODY_FONT_SIZE_PX,
  BODY_LINE_HEIGHT_PX,
  outlineContentBox,
  type SceneNode,
  SPATIAL_THEME_FONT_FAMILY,
  SPATIAL_THEME_GEOMETRY,
} from '@kamiazya/whiteboard-canvas-render'
import type { CommentThread, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { createEditorAppearance, editorTextFill } from '../../lib/spatial/editor-appearance.js'
import type { TextAnchor } from '../../lib/text-anchor.js'
import type { ResolvedTheme } from '../../lib/theme.js'
import { type GestureState, reduceGesture } from './gestures.js'
import { MarkdownNodeEditor } from './MarkdownNodeEditor.js'

/**
 * The in-place editor for a text node's markdown body. The scene keeps
 * drawing the node's chrome (its body is suppressed while this editor is
 * open), so the editor is TRANSPARENT and sits in the same box the
 * committed text uses: the silhouette's inscribed content box. A shaped
 * node therefore keeps its silhouette for the whole edit, and the text
 * does not jump on entering edit mode.
 */
export function MarkdownBodyEditorOverlay({
  node,
  selectionBox,
  sceneNodes,
  sceneCurrent,
  threads,
  onRequestComment,
  zoom,
  theme,
  canvas,
  gestureState,
  applyResult,
}: {
  /** The text node being edited (the caller has already narrowed the type). */
  readonly node: SpatialNode & { readonly type: 'text'; readonly text: string }
  readonly selectionBox: { x: number; y: number; width: number; height: number }
  readonly sceneNodes: readonly SceneNode[]
  readonly sceneCurrent: boolean
  readonly threads: readonly CommentThread[] | undefined
  readonly onRequestComment: (anchor: TextAnchor) => boolean
  readonly zoom: number
  readonly theme: ResolvedTheme
  readonly canvas: SpatialCanvas
  readonly gestureState: GestureState
  readonly applyResult: (result: ReturnType<typeof reduceGesture>) => void
}) {
  return (
    <MarkdownNodeEditor
      box={(() => {
        const chrome = sceneNodes.find((entry) => entry.kind === 'shape' && entry.id === node.id)
        const shapeId = chrome !== undefined && chrome.kind === 'shape' ? chrome.shape : undefined
        const bbox = {
          x: selectionBox.x,
          y: selectionBox.y,
          w: selectionBox.width,
          h: selectionBox.height,
        }
        const inner = outlineContentBox(shapeId, bbox)
        return { x: inner.x, y: inner.y, width: inner.w, height: inner.h }
      })()}
      initialText={node.text}
      // The conversations about passages of this node's text, highlighted
      // over the draft; and the comment verb's seam, which attaches the
      // caret's scope to this node and opens the compose bubble at the
      // node's corner, where a node comment opens. The editor commits on
      // the blur the bubble causes, so the passage the anchor quotes is
      // the text that gets committed.
      threads={threads?.filter(
        (thread) => thread.anchor.kind === 'text' && thread.anchor.nodeId === node.id,
      )}
      onRequestComment={onRequestComment}
      exitHintTop={selectionBox.y + selectionBox.height + 6}
      exitHintScale={1 / zoom}
      centerContent={sceneNodes.some(
        (entry) => entry.kind === 'shape' && entry.id === node.id && entry.shape !== undefined,
      )}
      style={{
        // Transparent once the scene below has stopped drawing this
        // node's text. An offloaded canvas lags one worker round trip
        // behind the suppression change, so for that gap the overlay
        // keeps the old opaque cover — otherwise the committed text
        // shows doubled under the draft.
        background: sceneCurrent
          ? 'transparent'
          : (() => {
              const fill = createEditorAppearance(theme).resolveNode(node).appearance?.fill
              return fill !== undefined && fill !== 'none'
                ? fill
                : theme === 'dark'
                  ? 'oklch(0.145 0 0)'
                  : '#ffffff'
            })(),
        color: editorTextFill(theme),
        fontFamily: SPATIAL_THEME_FONT_FAMILY,
        fontSize: BODY_FONT_SIZE_PX,
        // The overlay must advance by the SAME line box the committed
        // render uses, or the text moves under the cursor on entering
        // edit mode. Shared constant, not a second copy of the number —
        // these were equal until the markdown theme took body line
        // height to 1.5.
        lineHeight: `${BODY_LINE_HEIGHT_PX}px`,
        padding: SPATIAL_THEME_GEOMETRY.paddingPx,
      }}
      onCommit={(text) => {
        applyResult(reduceGesture(gestureState, canvas, { type: 'commit-text-edit', text }))
      }}
      onCancel={() => {
        applyResult(reduceGesture(gestureState, canvas, { type: 'cancel-text-edit' }))
      }}
      onChange={(text) => {
        applyResult(reduceGesture(gestureState, canvas, { type: 'update-text-edit', text }))
      }}
    />
  )
}
