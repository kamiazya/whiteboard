import type { MdastLayoutOptions, MeasureText, Scene } from '@kamiazya/whiteboard-canvas-render'
import {
  layoutMdastBlocks,
  renderSceneToSvg,
  SPATIAL_THEME_FONT_FAMILY,
  sceneBounds,
} from '@kamiazya/whiteboard-canvas-render'
import {
  type AliasResolver,
  parseMarkdownBlockLines,
  parseMarkdownBody,
  resolveReferences,
} from '@kamiazya/whiteboard-codec'
import { outlineFromScene } from '../../lib/document-outline.js'
import type { RailBlock } from './rail-geometry.js'

export interface RenderMarkdownPreviewOptions {
  readonly measure: MeasureText
  readonly maxWidth: number
  readonly background?: string
  /**
   * Maps `[[Name]]` aliases to canvas ids (codec's separate
   * resolution pass over the parsed tree). Absent, only a bare `[[ULID]]`
   * references resolve; unresolved aliases stay literal bracket text.
   */
  readonly resolveAlias?: AliasResolver
  /**
   * Resolves an embed target's parsed body for inline rendering
   * (canvas-render's layout seam, threaded through verbatim).
   */
  readonly resolveEmbed?: MdastLayoutOptions['resolveEmbed']
  /** Renders math blocks (canvas-render's layout seam, threaded verbatim). */
  readonly renderMath?: MdastLayoutOptions['renderMath']
  /** Renders diagram fences (canvas-render's layout seam, threaded verbatim). */
  readonly renderDiagram?: MdastLayoutOptions['renderDiagram']
}

/**
 * Pure parse -> layout -> serialize helper backing the preview pane. This is
 * the ONLY renderer for markdown in this component: it goes through
 * codec's `parseMarkdownBody` and canvas-render's `layoutMdastBlocks`
 * / `renderSceneToSvg`, the same path CanvasViewer uses for spatial text
 * nodes and export. There is no markdown-to-HTML fallback anywhere in this
 * file — that would be a second renderer and would reintroduce the
 * preview/export drift this migration exists to remove.
 *
 * Total by construction: `parseMarkdownBody` ends in a Zod `.parse()` call
 * and can throw on a tree shape the schema rejects, so a malformed body
 * (e.g. mid-edit) degrades to an empty scene instead of crashing the editor
 * on a keystroke.
 *
 * `renderMath` / `renderDiagram` come from the host (useMarkdownFragments'
 * cache-backed sync resolvers over the async MathJax/mermaid engines);
 * absent, math keeps canvas-render's documented escaped-source placeholder
 * and a diagram fence renders as a plain code block.
 */
export function renderMarkdownPreviewSvg(
  value: string,
  options: RenderMarkdownPreviewOptions,
): string {
  return renderMarkdownPreview(value, options).svg
}

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
  readonly svg: string
  readonly anchors: readonly PreviewBlockAnchor[]
  /**
   * Each top-level block's box, in the SVG's own pixel space — the same
   * origin the anchors use, and from the SAME layout pass, so the rail that
   * draws them can never disagree with what is painted beside it.
   */
  readonly blocks: readonly RailBlock[]
}

export const PREVIEW_PADDING_PX = 8

/**
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
    resolveAlias,
    resolveEmbed,
    renderMath,
    renderDiagram,
  }: RenderMarkdownPreviewOptions,
): RenderedMarkdownPreview {
  const scene = layoutScene(value, {
    measure,
    maxWidth,
    resolveAlias,
    resolveEmbed,
    renderMath,
    renderDiagram,
  })
  const svg = renderSceneToSvg(scene, { padding: PREVIEW_PADDING_PX, background })
  return { svg, anchors: blockAnchors(value, scene), blocks: blockBoxes(scene) }
}

/**
 * The rail's half of the render: block boxes and anchors, WITHOUT serializing
 * an SVG nobody reads.
 *
 * The rail draws rectangles, so the SVG string is pure waste on that path —
 * and it is paid per keystroke, in a worker, for a document that may be long.
 * Sharing `layoutScene` keeps the shape identical to what the preview would
 * paint; only the serialization is skipped.
 */
export function layoutMarkdownOutline(
  value: string,
  options: Omit<RenderMarkdownPreviewOptions, 'background'>,
): Pick<RenderedMarkdownPreview, 'anchors' | 'blocks'> {
  const scene = layoutScene(value, options)
  return { anchors: blockAnchors(value, scene), blocks: blockBoxes(scene) }
}

/** Top-level block boxes, shifted onto the SVG's pixel origin like anchors. */
function blockBoxes(scene: Scene): readonly RailBlock[] {
  if (scene.nodes.length === 0) return []
  const bounds = sceneBounds(scene)
  const originY = bounds.y - PREVIEW_PADDING_PX
  const originX = bounds.x - PREVIEW_PADDING_PX
  return outlineFromScene(scene).map((rect) => ({
    x: rect.x - originX,
    y: rect.y - originY,
    w: rect.w,
    h: rect.h,
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

function layoutScene(
  value: string,
  {
    measure,
    maxWidth,
    resolveAlias,
    resolveEmbed,
    renderMath,
    renderDiagram,
  }: Omit<RenderMarkdownPreviewOptions, 'background'>,
): Scene {
  try {
    return layoutMdastBlocks(resolveReferences(parseMarkdownBody(value), resolveAlias), {
      measure,
      maxWidth,
      fontFamily: SPATIAL_THEME_FONT_FAMILY,
      ...(resolveEmbed !== undefined ? { resolveEmbed } : {}),
      ...(renderMath !== undefined ? { renderMath } : {}),
      ...(renderDiagram !== undefined ? { renderDiagram } : {}),
    })
  } catch {
    return { nodes: [] }
  }
}
