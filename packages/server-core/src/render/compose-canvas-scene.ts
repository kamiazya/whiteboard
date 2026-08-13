import { parseMarkdownBody } from '@kamiazya/whiteboard-canvas-codec'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type {
  MeasureText,
  Scene,
  SpatialLayoutDegradation,
} from '@kamiazya/whiteboard-canvas-render'
import { createSpatialTheme, layoutSpatialCanvas } from '@kamiazya/whiteboard-canvas-render'
import { getLogger } from '../log.js'

// MCP render/digest are deliberately pinned to light (package-canvas-render.md
// decision #8): a user's ambient UI theme must never change what wb_scene_render
// or wb_scene_digest emit. Built once — the resolver is stateless.
const MCP_SCENE_APPEARANCE = createSpatialTheme({ mode: 'light' })

const log = getLogger('compose-canvas-scene')

// Keyed by every `SpatialLayoutDegradation['kind']`, so a kind added in
// canvas-render is a compile error here rather than a silently unreported
// degradation.
const DEGRADATION_MESSAGE: Record<SpatialLayoutDegradation['kind'], string> = {
  'body-parse-failed': 'text node body failed to parse as markdown; falling back to literal text',
  'unsupported-background-style': 'group backgroundStyle not supported; rendering as cover',
  'unknown-node-kind': 'unrecognized spatial node kind; emitting chrome only',
}

/** Reports a layout degradation via `getLogger`, since canvas-render itself cannot log. */
function onDegrade({ kind, ...data }: SpatialLayoutDegradation): void {
  log.warning(DEGRADATION_MESSAGE[kind], data)
}

/**
 * Composes a full-canvas scene from a `SpatialCanvas`. Delegates to
 * canvas-render's `layoutSpatialCanvas` — the single SpatialCanvas -> Scene
 * builder shared by every consumer (package-canvas-render.md decision #7).
 * No `resolveFileCanvas`/`resolveFileImage`/`resolveFileLabel`/`expandFileNode`
 * are passed, which keeps the MCP surface a pure function of the canvas
 * snapshot (decision #10's opt-in rule) — a file node renders as chrome +
 * label regardless of whether the reference resolves to anything.
 */
export function composeCanvasScene(canvas: SpatialCanvas, measure: MeasureText): Scene {
  return layoutSpatialCanvas(canvas, {
    measure,
    parseBody: parseMarkdownBody,
    appearance: MCP_SCENE_APPEARANCE,
    onDegrade,
  })
}

/**
 * Union bounding box over every top-level node's own geometry — the `<svg>`
 * root's width/height for `wb_scene_render`. An empty canvas has no
 * geometry to union, so it defaults to a zero-sized box rather than an
 * arbitrary sentinel.
 */
export function computeCanvasDimensions(nodes: readonly SpatialNode[]): {
  width: number
  height: number
} {
  if (nodes.length === 0) return { width: 0, height: 0 }

  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const node of nodes) {
    maxX = Math.max(maxX, node.x + node.width)
    maxY = Math.max(maxY, node.y + node.height)
  }
  return { width: maxX, height: maxY }
}
