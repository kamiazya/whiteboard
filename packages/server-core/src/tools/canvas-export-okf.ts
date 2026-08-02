import type { OkfMarkdownFrontmatter } from '@kamiazya/whiteboard-canvas-codec'
import { okfMarkdownFrontmatterSchema, serializeOkf } from '@kamiazya/whiteboard-canvas-codec'
import { canvasIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { readCoreFacets, readFacets } from '@kamiazya/whiteboard-canvas-workspace'
import { z } from 'zod'
import { loadSpatialCanvas } from '../render/load-spatial-canvas.js'
import type { ServerDeps } from '../server-deps.js'

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
 * is the fallback value used ONLY when no core meta was ever persisted for
 * this doc (every canvas created before this bridge existed, or a
 * spatial-only canvas that never went through `canvas_import_okf`). Once a
 * doc has stored core meta (via `writeCoreFacets`), that stored `type`
 * (and `title`/`tags`/`view`/`facetsRaw`) is echoed back instead — this is
 * what makes the `canvas_import_okf` -> `canvas_export_okf` round-trip
 * faithful.
 */
const OKF_EXPORT_PLACEHOLDER_TYPE = 'canvas'

export function createCanvasExportOkfTool(deps: ServerDeps) {
  return {
    name: 'canvas_export_okf' as const,
    inputSchema: canvasExportOkfInputSchema,
    outputSchema: canvasExportOkfOutputSchema,
    async execute(input: CanvasExportOkfInput): Promise<CanvasExportOkfOutput> {
      const { doc, canvas } = await loadSpatialCanvas(deps, input.canvasId)
      const coreMeta = readCoreFacets(doc)
      const facets = readFacets(doc)
      const body = canvas.nodes.find((node) => node.type === 'text')?.text ?? ''
      const frontmatter: OkfMarkdownFrontmatter = {
        ...(coreMeta ?? { type: OKF_EXPORT_PLACEHOLDER_TYPE }),
        facets,
      }
      const markdown = serializeOkf({ frontmatter, body })
      return { markdown, frontmatter }
    },
  }
}
