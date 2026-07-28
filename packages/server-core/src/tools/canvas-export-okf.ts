import { canvasIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { okfMarkdownFrontmatterSchema, serializeOkf } from '@kamiazya/whiteboard-canvas-codec'
import type { OkfMarkdownFrontmatter } from '@kamiazya/whiteboard-canvas-codec'
import { readFacets } from '@kamiazya/whiteboard-canvas-workspace'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadSpatialCanvas } from '../render/load-spatial-canvas.js'

/**
 * OKF-Markdown is a single-document format (frontmatter + body); a spatial
 * canvas can have many independently-positioned text nodes. This tool
 * targets only the FIRST text node found (or an empty body when none
 * exists) — a real "canvas -> OKF" mapping for a full multi-node spatial
 * canvas is deferred to a future slice once the OKF-vs-spatial duality is
 * resolved in canvas-workspace.
 *
 * `CanvasDocStore.loadSnapshot`'s `DocRef` carries no `workspaceId` — this
 * field is accepted for API symmetry with workspace-scoped tools and as a
 * future authorization-scoping hook, not passed to the store.
 */
export const canvasExportOkfInputSchema = z
  .object({ workspaceId: workspaceIdSchema, canvasId: canvasIdSchema })
  .strict()
export type CanvasExportOkfInput = z.infer<typeof canvasExportOkfInputSchema>

export const canvasExportOkfOutputSchema = z
  .object({ markdown: z.string(), frontmatter: okfMarkdownFrontmatterSchema })
  .strict()
export type CanvasExportOkfOutput = z.infer<typeof canvasExportOkfOutputSchema>

/**
 * `coreFacetsSchema.type` is required, but a spatial (JSON Canvas) doc has
 * no notion of an OKF core-facet `type` of its own — the two formats are
 * deliberately distinct document shapes (package-canvas-codec.md). `canvas`
 * is a fixed placeholder value for this export path until canvas-workspace
 * defines a real spatial-canvas-to-OKF-type mapping.
 */
const OKF_EXPORT_PLACEHOLDER_TYPE = 'canvas'

export function createCanvasExportOkfTool(deps: ServerDeps) {
  return {
    name: 'canvas_export_okf' as const,
    inputSchema: canvasExportOkfInputSchema,
    outputSchema: canvasExportOkfOutputSchema,
    async execute(input: CanvasExportOkfInput): Promise<CanvasExportOkfOutput> {
      const { doc, canvas } = await loadSpatialCanvas(deps, input.canvasId)
      const facets = readFacets(doc)
      const body = canvas.nodes.find((node) => node.type === 'text')?.text ?? ''
      const frontmatter: OkfMarkdownFrontmatter = { type: OKF_EXPORT_PLACEHOLDER_TYPE, facets }
      const markdown = serializeOkf({ frontmatter, body })
      return { markdown, frontmatter }
    },
  }
}
