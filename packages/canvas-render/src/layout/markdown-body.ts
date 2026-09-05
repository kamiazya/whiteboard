import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { withReferenceSeams } from '../references/seams.js'
import type { Scene } from '../scene-graph.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { layoutMdastBlocks as layoutBlocks, type MdastLayoutOptions } from './nodes/mdast-blocks.js'
import type { SpatialAppearanceResolver } from './nodes/spatial-appearance.js'
import { fitSceneIntoBox, layoutSpatialCanvas } from './spatial-canvas.js'

export interface MarkdownBodyLayoutOptions extends MdastLayoutOptions {
  /**
   * How an embedded canvas's nodes and edges are painted. Defaults to the
   * bundled light theme; a themed surface passes its own so a miniature
   * matches the page around it.
   */
  readonly canvasAppearance?: SpatialAppearanceResolver
}

/**
 * The markdown layout every surface calls — preview, export, the MCP Apps
 * widget — with a canvas-targeted `![[embed]]` drawn by the spatial composer
 * BY DEFAULT. The typesetter (`nodes/mdast-blocks.ts`) cannot import the
 * composer, since the layout clusters stay below it, so the wiring lives
 * here, one level up, where both are in reach.
 *
 * A default rather than an opt-in, for the lowlight reason
 * (architecture-map.md): a seam every call site has to remember is one a
 * call site forgets, and the surface that forgets does not fall back to the
 * same picture — it draws a placeholder where the others draw the canvas.
 * The composer's own text-node bodies are wired inside `spatial-canvas.ts`
 * and do not pass through here.
 */
export function layoutMdastBlocks(root: MdastRoot, input: MarkdownBodyLayoutOptions): Scene {
  const options = withReferenceSeams(input)
  const { canvasAppearance, ...rest } = options
  return layoutBlocks(root, {
    layoutEmbeddedCanvas: (canvas, box) =>
      fitSceneIntoBox(
        layoutSpatialCanvas(canvas, {
          measure: options.measure,
          appearance: canvasAppearance ?? createSpatialTheme({ mode: 'light' }),
          embedPath: box.embedPath,
          ...(options.highlightCode !== undefined ? { highlightCode: options.highlightCode } : {}),
          ...(options.renderMath !== undefined ? { renderMath: options.renderMath } : {}),
          ...(options.renderDiagram !== undefined ? { renderDiagram: options.renderDiagram } : {}),
          // The whole bundle, not the two seams a body reads: a canvas
          // embedded in a note has file nodes of its own, and those read
          // `resolveReference`, which the note's layout never touches.
          ...(options.references !== undefined ? { references: options.references } : {}),
          ...(options.resolveEmbed !== undefined ? { resolveEmbed: options.resolveEmbed } : {}),
          ...(options.resolveTitle !== undefined ? { resolveTitle: options.resolveTitle } : {}),
        }),
        box,
      ),
    ...rest,
  })
}
