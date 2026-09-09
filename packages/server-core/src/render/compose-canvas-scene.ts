import type {
  MeasureText,
  ReferenceSeams,
  Scene,
  SpatialLayoutDegradation,
  SpatialRenderStyle,
} from '@kamiazya/whiteboard-canvas-render'
import {
  type BoundingBox,
  createSpatialTheme,
  layoutSpatialCanvas,
  sceneBounds,
} from '@kamiazya/whiteboard-canvas-render'
import type { CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { getLogger } from '../log.js'

// MCP render/digest are deliberately pinned to light (package-canvas-render.md
// decision #8): a user's ambient UI theme must never change what wb_scene_render
// or wb_canvas_snapshot's layout analysis emit. Built once — the resolver
// is stateless.
export const MCP_SCENE_APPEARANCE = createSpatialTheme({ mode: 'light' })

const log = getLogger('compose-canvas-scene')

// Keyed by every `SpatialLayoutDegradation['kind']`, so a kind added in
// canvas-render is a compile error here rather than a silently unreported
// degradation.
const DEGRADATION_MESSAGE: Record<SpatialLayoutDegradation['kind'], string> = {
  'body-parse-failed': 'text node body failed to parse as markdown; falling back to literal text',
  'unsupported-background-style': 'group backgroundStyle not supported; rendering as cover',
  'unknown-node-kind': 'unrecognized spatial node kind; emitting chrome only',
  'unknown-theme': 'canvas names a theme no plugin registered; drawing the bundled look',
  'font-missing': 'theme names a font family this daemon cannot measure; declaring the bundled one',
}

/** Reports a layout degradation via `getLogger`, since canvas-render itself cannot log. */
function onDegrade({ kind, ...data }: SpatialLayoutDegradation): void {
  log.warning(DEGRADATION_MESSAGE[kind], data)
}

/**
 * What a caller has already resolved for everything this canvas points at
 * — its file nodes, and the links and embeds inside every body — as the
 * one bundle `referenceSeams` builds. Absent — the default — keeps the
 * scene a pure function of the canvas snapshot.
 */
export interface ComposeCanvasSceneOptions {
  readonly references?: ReferenceSeams
  /** The document's conversations, for passage highlights inside text nodes. */
  readonly threads?: readonly CommentThread[]
  /**
   * Which look to draw (ADR-0030 decision 6). Absent is `'clean'` — the
   * layout's own default, kept explicit here because this composer serves
   * the digest too, and a digest must never move because a theme did.
   */
  readonly style?: SpatialRenderStyle
}

/**
 * Composes a full-canvas scene from a `SpatialCanvas`. Delegates to
 * canvas-render's `layoutSpatialCanvas` — the single SpatialCanvas -> Scene
 * builder shared by every consumer (package-canvas-render.md decision #7).
 *
 * With no `references`, no file seam is passed at all, which keeps the scene
 * a pure function of the canvas snapshot (decision #10's opt-in rule) — a
 * file node renders as chrome + label regardless of whether the reference
 * resolves to anything. The layout analysis depends on exactly that: a result
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
    ...(options?.style === undefined ? {} : { style: options.style }),
    ...(options?.threads === undefined ? {} : { threads: options.threads }),
    // A render has no on-screen size to gate a miniature by, so every
    // resolved canvas reference expands — export's policy, in the editor's
    // words: a node's intrinsic size, not its zoom.
    ...(references === undefined ? {} : { references, expandFileNode: () => true }),
  })
}

/**
 * The box `wb_scene_render`'s SVG is drawn in: the scene's own bounds, so
 * the viewBox starts where the drawing starts. A container's label sits
 * ABOVE its frame, and an SVG anchored at 0,0 cropped every label of a layer
 * drawn at y=0 — the lane's architecture diagram came back without its
 * first layer's name.
 *
 * Measured from the SCENE, not the canvas's nodes. The two agree only while
 * nothing is drawn outside a node's own box, and the router deliberately
 * breaks that: an edge steps AROUND a node it would otherwise cut through,
 * and that step lands beyond every node's geometry. An empty scene has no
 * geometry to measure and reports an empty box rather than `sceneBounds`'
 * non-degenerate 1x1 fallback.
 */
export function sceneEnvelope(scene: Scene): BoundingBox {
  if (scene.nodes.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  return sceneBounds(scene)
}
