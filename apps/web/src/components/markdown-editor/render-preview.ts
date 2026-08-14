import {
  type AliasResolver,
  parseMarkdownBody,
  resolveReferences,
} from '@kamiazya/whiteboard-canvas-codec'
import type { MdastLayoutOptions, MeasureText, Scene } from '@kamiazya/whiteboard-canvas-render'
import {
  layoutMdastBlocks,
  renderSceneToSvg,
  SPATIAL_THEME_FONT_FAMILY,
} from '@kamiazya/whiteboard-canvas-render'

export interface RenderMarkdownPreviewOptions {
  readonly measure: MeasureText
  readonly maxWidth: number
  readonly background?: string
  /**
   * Maps `[[Name]]` aliases to canvas ids (canvas-codec's separate
   * resolution pass over the parsed tree). Absent, only `[[canvas:ULID]]`
   * references resolve; unresolved aliases stay literal bracket text.
   */
  readonly resolveAlias?: AliasResolver
  /**
   * Resolves an embed target's parsed body for inline rendering
   * (canvas-render's layout seam, threaded through verbatim).
   */
  readonly resolveEmbed?: MdastLayoutOptions['resolveEmbed']
}

/**
 * Pure parse -> layout -> serialize helper backing the preview pane. This is
 * the ONLY renderer for markdown in this component: it goes through
 * canvas-codec's `parseMarkdownBody` and canvas-render's `layoutMdastBlocks`
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
 * No `renderMath` is supplied — math blocks fall back to canvas-render's
 * documented escaped-source placeholder rather than silently vanishing;
 * injecting a real MathJax renderer is out of scope for this slice.
 */
export function renderMarkdownPreviewSvg(
  value: string,
  { measure, maxWidth, background, resolveAlias, resolveEmbed }: RenderMarkdownPreviewOptions,
): string {
  return renderSceneToSvg(layoutScene(value, measure, maxWidth, resolveAlias, resolveEmbed), {
    padding: 8,
    background,
  })
}

function layoutScene(
  value: string,
  measure: MeasureText,
  maxWidth: number,
  resolveAlias?: AliasResolver,
  resolveEmbed?: MdastLayoutOptions['resolveEmbed'],
): Scene {
  try {
    return layoutMdastBlocks(resolveReferences(parseMarkdownBody(value), resolveAlias), {
      measure,
      maxWidth,
      fontFamily: SPATIAL_THEME_FONT_FAMILY,
      ...(resolveEmbed !== undefined ? { resolveEmbed } : {}),
    })
  } catch {
    return { nodes: [] }
  }
}
