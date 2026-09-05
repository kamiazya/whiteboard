import {
  BODY_FONT_SIZE_PX,
  BODY_LINE_HEIGHT_PX,
  type BoundingBox,
  COMMENT_BUBBLE_PADDING_PX,
  COMMENT_BUBBLE_RADIUS_PX,
  commentAnchor,
  placeCommentBubble,
  SPATIAL_DARK_PALETTE,
  SPATIAL_LIGHT_PALETTE,
  SPATIAL_THEME_FONT_FAMILY,
} from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { editorTextFill } from '../../lib/spatial/editor-appearance.js'
import type { Point } from '../../lib/spatial/viewport.js'
import type { ResolvedTheme } from '../../lib/theme.js'
import type { CommentComposeState } from './CanvasContextMenu.js'
import { defaultCreateId, type reduceGesture } from './gestures.js'
import { TextNodeEditor } from './TextNodeEditor.js'

/** The compose bubble sits where the saved comment's bubble will be drawn,
 * so committing reads as the draft settling rather than jumping. */
const COMMENT_COMPOSE_WIDTH_PX = 216
const COMMENT_COMPOSE_HEIGHT_PX = 64

/**
 * Where the draft opens: placed by canvas-render's own bubble placer over
 * the same obstacles, so it opens in the quadrant the settled bubble will
 * take rather than over the node the comment is about.
 */
function commentDraftBox(
  anchor: Point,
  obstacles: readonly BoundingBox[],
): { x: number; y: number; width: number; height: number } {
  const placed = placeCommentBubble(
    anchor,
    { w: COMMENT_COMPOSE_WIDTH_PX, h: COMMENT_COMPOSE_HEIGHT_PX },
    obstacles,
  )
  return { x: placed.x, y: placed.y, width: placed.w, height: placed.h }
}

/**
 * The compose bubble wears the theme's comment chrome — the same palette
 * entry, padding and corner the renderer draws the settled bubble with —
 * so the draft and the saved comment read as one object rather than a
 * plain editor a card replaces on commit. CommentThreadCard wears the
 * same chrome, which is why this is exported rather than file-private. The shadow mirrors the SVG
 * drop-shadow filter (dy 1, blur ~3px at 30% black) that lifts the
 * settled chrome off the canvas plane.
 */
export function commentComposeStyle(theme: ResolvedTheme): React.CSSProperties {
  const { bubble } = (theme === 'dark' ? SPATIAL_DARK_PALETTE : SPATIAL_LIGHT_PALETTE).comment
  return {
    background: bubble.fill,
    color: editorTextFill(theme),
    border: `1px solid ${bubble.stroke}`,
    borderRadius: COMMENT_BUBBLE_RADIUS_PX,
    padding: COMMENT_BUBBLE_PADDING_PX,
    // Focus is shown as a soft halo in the bubble's own stroke colour
    // rather than the UA's dark outline ring, which read as a second,
    // heavier border around the card. The bubble is only ever mounted
    // focused, so the halo is always the focus indicator.
    outline: 'none',
    boxShadow: `0 0 0 2px ${bubble.stroke}55, 0 1px 3px rgba(0, 0, 0, 0.3)`,
    fontFamily: SPATIAL_THEME_FONT_FAMILY,
    fontSize: BODY_FONT_SIZE_PX,
    lineHeight: `${BODY_LINE_HEIGHT_PX}px`,
    // Size to the draft like the settled bubble sizes to its text: one
    // line to start, growing as lines are added (`field-sizing`; browsers
    // without it keep the one-line minimum and scroll).
    height: 'auto',
    minHeight: BODY_LINE_HEIGHT_PX + 2 * COMMENT_BUBBLE_PADDING_PX + 2,
    ...({ fieldSizing: 'content' } as React.CSSProperties),
  }
}

/**
 * The comment draft bubble: rewriting an existing comment's text, opening a
 * THREAD when a passage/node-set anchor is attached (a flat comment cannot
 * carry either), or creating a flat comment at a point. A blank commit is a
 * cancel — an empty comment says nothing and would still ask the reader to
 * resolve it; editing an existing comment to blank likewise keeps its
 * stored text (removal stays MCP-only in v1, ADR-0025).
 */
export function CommentComposeOverlay({
  compose,
  canvas,
  edgePathOf,
  obstacles,
  createId,
  zoom,
  theme,
  applyResult,
  onClose,
}: {
  readonly compose: CommentComposeState
  readonly canvas: SpatialCanvas
  readonly edgePathOf: (edgeId: string) => readonly Point[] | undefined
  /** Precomputed by the caller so its obstacle closure stays where the boxes live. */
  readonly obstacles: readonly BoundingBox[]
  readonly createId?: () => string
  readonly zoom: number
  readonly theme: ResolvedTheme
  readonly applyResult: (result: ReturnType<typeof reduceGesture>) => void
  readonly onClose: () => void
}) {
  return (
    <TextNodeEditor
      exitHintScale={1 / zoom}
      box={commentDraftBox(
        // An edge comment opens ON the routed path, where the layer
        // will pin it — one producer for the geometry.
        compose.targetEdgeId === undefined
          ? compose.point
          : commentAnchor(
              {
                id: '',
                text: ' ',
                x: compose.point.x,
                y: compose.point.y,
                targetEdgeId: compose.targetEdgeId,
              },
              canvas,
              edgePathOf,
            ),
        obstacles,
      )}
      initialText={compose.editing?.initialText ?? ''}
      testId="comment-compose"
      style={commentComposeStyle(theme)}
      onCommit={(draft) => {
        const text = draft.trim()
        if (compose.editing !== undefined) {
          if (text.length > 0 && text !== compose.editing.initialText) {
            applyResult({
              state: { kind: 'idle' },
              commands: [{ kind: 'set-comment-text', id: compose.editing.id, text } as const],
            })
          }
        } else if (text.length > 0 && compose.threadAnchor !== undefined) {
          const id = (createId ?? defaultCreateId)()
          const createdAt = new Date().toISOString()
          applyResult({
            state: { kind: 'idle' },
            commands: [
              {
                kind: 'create-thread',
                thread: {
                  id,
                  anchor: compose.threadAnchor,
                  status: 'open',
                  createdAt,
                  messages: [{ id: `${id}-m1`, body: text, createdAt }],
                },
              } as const,
            ],
          })
        } else if (text.length > 0) {
          const { point, targetNodeId, targetEdgeId } = compose
          applyResult({
            state: { kind: 'idle' },
            commands: [
              {
                kind: 'create-comment',
                comment: {
                  id: (createId ?? defaultCreateId)(),
                  // Rounded for the same reason the pin drag rounds:
                  // an integer by schema, and a fractional anchor
                  // is dropped on read rather than rejected here.
                  x: Math.round(point.x),
                  y: Math.round(point.y),
                  text,
                  createdAt: new Date().toISOString(),
                  ...(targetNodeId === undefined ? {} : { targetNodeId }),
                  ...(targetEdgeId === undefined ? {} : { targetEdgeId }),
                },
              } as const,
            ],
          })
        }
        onClose()
      }}
      onCancel={onClose}
    />
  )
}
