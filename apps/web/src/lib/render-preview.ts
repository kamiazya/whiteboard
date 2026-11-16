import type { MeasureText, ReferenceSeams, Scene } from '@kamiazya/whiteboard-canvas-render'
import {
  type KeyedSvgRender,
  layoutMarkdownDocument,
  renderSceneToKeyedSvg,
  sceneBounds,
} from '@kamiazya/whiteboard-canvas-render'
import { hasLoadedFace } from '@kamiazya/whiteboard-canvas-viewer/font-loading'
import { parseMarkdownBlockLines } from '@kamiazya/whiteboard-codec'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { getAppLogger } from './app-logger.js'
import { outlineBlocks } from './document-outline.js'
import type { FragmentTable } from './fragment-requests.js'
import { PREVIEW_PADDING_PX } from './preview-padding.js'
import type { RailBlock } from './rail-geometry.js'
import { currentLayoutCore } from './spatial/layout-core.js'
import type { ResolvedTheme } from './theme.js'

export interface RenderMarkdownPreviewOptions {
  readonly measure: MeasureText
  readonly maxWidth: number
  readonly background?: string
  /**
   * Every reference seam at once — `[[path]]` aliases (codec's separate
   * resolution pass over the parsed tree), display names, embed targets —
   * as the bundle canvas-render's `referenceSeams` builds. Absent, only a
   * bare `[[ULID]]` resolves, unresolved aliases stay literal bracket text,
   * and every embed is a placeholder.
   */
  readonly references?: ReferenceSeams
  /**
   * The app theme an embedded CANVAS is painted in, so its miniature matches
   * the page around it. The markdown itself is themed by the host's
   * inherited fill, not here; absent, a miniature takes the light theme.
   */
  readonly theme?: ResolvedTheme
  /**
   * The rendered math blocks and diagram fences, as the table the Rust core
   * can be handed (`useMarkdownFragments().table`); a source it lacks is
   * drawn as its fallback and reported to the table's listener. Absent, math
   * keeps canvas-render's escaped-source placeholder and a diagram fence is a
   * plain code block, and nothing is reported.
   */
  readonly fragments?: FragmentTable
  /**
   * The workspace's tag library, so a board embedded in the note is coloured
   * by intent exactly as the editor colours it (ADR-0040 decision 5).
   */
  readonly tagLibrary?: TagLibrary
}

// A failed layout still answers an empty scene, but says so: under
// VITE_WHITEBOARD_CORE_MISMATCH=throw a routing difference in a board embedded
// in a note lands in that catch, and a silent blank would hide it.
const log = getAppLogger('render-preview')
/**
 * One top-level block's scroll-sync anchor: its 1-based source start line
 * paired with its top edge in the emitted SVG's own pixel space (viewBox
 * origin already folded in, so `y` is directly comparable to a pixel
 * offset inside the rendered element).
 */
export interface PreviewBlockAnchor {
  readonly line: number
  readonly y: number
}

export interface RenderedMarkdownPreview {
  /** Keyed projection of the preview document: `keyed.svg` is the full
   * byte-identical document for string consumers (the worker protocol); the groups feed the pane's DOM patcher. */
  readonly keyed: KeyedSvgRender
  readonly anchors: readonly PreviewBlockAnchor[]
  /**
   * Each top-level block's box, in the SVG's own pixel space — the same
   * origin the anchors use, and from the SAME layout pass, so the rail that
   * draws them can never disagree with what is painted beside it.
   */
  readonly blocks: readonly RailBlock[]
}

export { PREVIEW_PADDING_PX }

/**
 * Parse -> layout -> serialize, backing the preview pane. This is the ONLY
 * renderer for markdown in this component: it goes through canvas-render's
 * `layoutMarkdownDocument` (codec's parser and `layoutMdastBlocks`, or the
 * Rust core's markdown entry, as the realm's core and its switch say) and
 * `renderSceneToSvg`, the same path CanvasViewer uses for spatial text nodes
 * and export. There is no markdown-to-HTML fallback anywhere in this file —
 * that would be a second renderer and would reintroduce the preview/export
 * drift this migration exists to remove.
 *
 * Total by construction: `parseMarkdownBody` ends in a Zod `.parse()` call
 * and can throw on a tree shape the schema rejects, so a malformed body
 * (e.g. mid-edit) degrades to an empty scene instead of crashing the editor
 * on a keystroke.
 *
 * `fragments` comes from the host (useMarkdownFragments' table over the
 * async MathJax/mermaid engines), as data rather than as the
 * `renderMath`/`renderDiagram` function seams, which the core cannot be
 * handed.
 *
 * The SVG plus per-block scroll-sync anchors from the SAME layout pass —
 * anchors derived from a second layout could disagree with what is
 * painted (fragment seams change block heights). Source lines come from
 * codec's position sidecar, index-aligned with the scene's
 * top-level nodes (both map `root.children` 1:1). Empty anchors (an
 * unparseable mid-edit body) tell the caller to keep its proportional
 * fallback.
 */
export function renderMarkdownPreview(
  value: string,
  {
    measure,
    maxWidth,
    background,
    references,
    theme,
    fragments,
    tagLibrary,
  }: RenderMarkdownPreviewOptions,
): RenderedMarkdownPreview {
  const scene = layoutMarkdownScene(value, {
    measure,
    maxWidth,
    references,
    theme,
    fragments,
    tagLibrary,
  })
  const keyed = renderSceneToKeyedSvg(scene, { padding: PREVIEW_PADDING_PX, background })
  return { keyed, anchors: blockAnchors(value, scene), blocks: blockBoxes(scene) }
}

/**
 * The rail's half of the render: block boxes and anchors, WITHOUT serializing
 * an SVG nobody reads.
 *
 * The rail draws rectangles, so the SVG string is pure waste on that path —
 * and it is paid per keystroke, in a worker, for a document that may be long.
 * Sharing `layoutMarkdownScene` keeps the shape identical to what the preview would
 * paint; only the serialization is skipped.
 */
export function layoutMarkdownOutline(
  value: string,
  options: Omit<RenderMarkdownPreviewOptions, 'background'>,
): Pick<RenderedMarkdownPreview, 'anchors' | 'blocks'> {
  const scene = layoutMarkdownScene(value, options)
  return { anchors: blockAnchors(value, scene), blocks: blockBoxes(scene) }
}

/** Top-level block boxes, shifted onto the SVG's pixel origin like anchors. */
function blockBoxes(scene: Scene): readonly RailBlock[] {
  if (scene.nodes.length === 0) return []
  const bounds = sceneBounds(scene)
  const originY = bounds.y - PREVIEW_PADDING_PX
  const originX = bounds.x - PREVIEW_PADDING_PX
  return outlineBlocks(scene).map(({ rect, heading }) => ({
    x: rect.x - originX,
    y: rect.y - originY,
    w: rect.w,
    h: rect.h,
    ...(heading ? { heading: true as const } : {}),
  }))
}

function blockAnchors(value: string, scene: Scene): readonly PreviewBlockAnchor[] {
  if (scene.nodes.length === 0) return []
  let lines: readonly number[]
  try {
    lines = parseMarkdownBlockLines(value)
  } catch {
    return []
  }
  // The SVG's pixel origin is the padded viewBox top (renderSceneToSvg
  // derives viewBox = bounds expanded by padding).
  const originY = sceneBounds(scene).y - PREVIEW_PADDING_PX
  const anchors: PreviewBlockAnchor[] = []
  for (let i = 0; i < Math.min(lines.length, scene.nodes.length); i++) {
    const node = scene.nodes[i]
    const line = lines[i]
    if (node === undefined || line === undefined || !('bbox' in node)) continue
    anchors.push({ line, y: node.bbox.y - originY })
  }
  return anchors
}

/** The note's scene itself, before the pane pads and keys it. */
function layoutMarkdownScene(
  value: string,
  {
    measure,
    maxWidth,
    references,
    theme,
    fragments,
    tagLibrary,
  }: Omit<RenderMarkdownPreviewOptions, 'background'>,
): Scene {
  try {
    // A page, not an object: the document theme and the bundled family are
    // the switch's own, so the minimap rail, which maps THESE blocks, is
    // laid out from the same metrics as the pane beside it.
    const scene = layoutMarkdownDocument(value, {
      measure,
      maxWidth,
      // The app theme an embedded board is painted in, so its miniature
      // matches the page around it.
      mode: theme ?? 'light',
      // A human surface draws the document (ADR-0030 decision 6), so a
      // board embedded in a note is pencilled or glowing here exactly as
      // it is on the canvas — the same default the spatial surfaces take.
      style: 'document',
      // The note's own prose is measured in the bundled family. A board
      // EMBEDDED in it declares its theme's family only where a face for it
      // is held, exactly as `editorLayoutBase` answers for the canvas
      // surfaces (ADR-0011's invariant).
      fontAvailable: hasLoadedFace,
      core: currentLayoutCore(),
      ...(references !== undefined ? { references } : {}),
      ...(fragments !== undefined
        ? { fragments: fragments.fragments, onFragmentsAsked: fragments.onFragmentsAsked }
        : {}),
      ...(tagLibrary !== undefined ? { tagLibrary } : {}),
    })
    // Undefined only for a `section`, which the preview never asks for.
    return scene ?? { nodes: [] }
  } catch (error) {
    log.warn('markdown preview layout failed; rendering an empty scene', error)
    return { nodes: [] }
  }
}
