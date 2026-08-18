import type {
  MeasureText,
  ResolvedReference,
  Scene,
  SpatialLayoutDegradation,
} from '@kamiazya/whiteboard-canvas-render'
import {
  createSpatialTheme,
  layoutSpatialCanvas,
  sceneBounds,
} from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
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
 * What a caller has already resolved for this canvas's file references.
 * Absent — the default — keeps the scene a pure function of the canvas
 * snapshot.
 */
export interface ComposeCanvasSceneOptions {
  readonly references?: ReadonlyMap<string, ResolvedReference>
}

/**
 * Composes a full-canvas scene from a `SpatialCanvas`. Delegates to
 * canvas-render's `layoutSpatialCanvas` — the single SpatialCanvas -> Scene
 * builder shared by every consumer (package-canvas-render.md decision #7).
 *
 * With no `references`, no file seam is passed at all, which keeps the scene
 * a pure function of the canvas snapshot (decision #10's opt-in rule) — a
 * file node renders as chrome + label regardless of whether the reference
 * resolves to anything. `wb_scene_digest` depends on exactly that: a digest
 * that moved whenever a DIFFERENT document was edited would stop being
 * usable as a change signal for the canvas it names.
 *
 * `wb_scene_render` opts in per call, which is why this is a parameter
 * rather than a dependency read in here. Resolution is the caller's, also
 * because it is asynchronous while the seams are synchronous by contract.
 */
export function composeCanvasScene(
  canvas: SpatialCanvas,
  measure: MeasureText,
  options?: ComposeCanvasSceneOptions,
): Scene {
  const references = options?.references
  return layoutSpatialCanvas(canvas, {
    measure,
    appearance: MCP_SCENE_APPEARANCE,
    onDegrade,
    ...(references === undefined ? {} : { resolveReference: (ref: string) => references.get(ref) }),
  })
}

/**
 * How far the drawing extends from the origin — the size a consumer needs to
 * show all of `wb_scene_render`'s SVG.
 *
 * Measured from the SCENE, not the canvas's nodes. The two agree only while
 * nothing is drawn outside a node's own box, and the router deliberately
 * breaks that: an edge steps AROUND a node it would otherwise cut through,
 * and that step lands beyond every node's geometry. Measuring the nodes
 * reported a size that clipped the very detours the routing work added.
 *
 * Right/bottom extent rather than `sceneBounds`' width/height, because the
 * SVG this describes is the bodyless-root form with no `viewBox`: its user
 * space starts at the origin whatever the content does, so a consumer needs
 * the far edge, not the span. An empty scene has no geometry to measure and
 * reports zero rather than `sceneBounds`' non-degenerate 1x1 fallback.
 */
export function computeSceneDimensions(scene: Scene): { width: number; height: number } {
  if (scene.nodes.length === 0) return { width: 0, height: 0 }
  const bounds = sceneBounds(scene)
  return { width: bounds.x + bounds.w, height: bounds.y + bounds.h }
}
