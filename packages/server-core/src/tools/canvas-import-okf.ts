import { parseOkf } from '@kamiazya/whiteboard-canvas-codec'
import { canvasIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-canvas-model'
import {
  writeCoreFacets,
  writeFacets,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-canvas-workspace'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadOrCreateCanvasDoc, saveDocSnapshot } from './canvas-doc-io.js'
import { withReindex } from './with-reindex.js'
import { assertCanvasInWorkspace } from './workspace-tree-io.js'

const TEXT_NODE_ID = 'okf-body'

export const canvasImportOkfInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    canvasId: canvasIdSchema,
    markdown: z.string(),
  })
  .strict()
export type CanvasImportOkfInput = z.infer<typeof canvasImportOkfInputSchema>

export const canvasImportOkfOutputSchema = z
  .object({
    canvasId: canvasIdSchema,
    imported: z.literal(true),
  })
  .strict()
export type CanvasImportOkfOutput = z.infer<typeof canvasImportOkfOutputSchema>

export class OkfParseError extends Error {
  constructor(
    public readonly stage: string,
    message: string,
  ) {
    super(`OKF parse failed at ${stage}: ${message}`)
    this.name = 'OkfParseError'
  }
}

export function createCanvasImportOkfTool(deps: ServerDeps) {
  return {
    name: 'canvas_import_okf' as const,
    inputSchema: canvasImportOkfInputSchema,
    outputSchema: canvasImportOkfOutputSchema,
    execute: withReindex(
      deps,
      async (input: CanvasImportOkfInput): Promise<CanvasImportOkfOutput> => {
        await assertCanvasInWorkspace(deps.canvasDocStore, input.workspaceId, input.canvasId)

        const parsed = parseOkf(input.markdown)
        if (!parsed.ok) {
          throw new OkfParseError(parsed.error.stage, parsed.error.message)
        }

        const { frontmatter, body } = parsed.value
        const doc = await loadOrCreateCanvasDoc(deps, input.canvasId)

        const { facets, ...coreMeta } = frontmatter
        writeCoreFacets(doc, coreMeta)
        if (facets) {
          writeFacets(doc, facets)
        }

        const nodes =
          body.length > 0
            ? [
                {
                  id: TEXT_NODE_ID,
                  type: 'text' as const,
                  x: 0,
                  y: 0,
                  width: 600,
                  height: 400,
                  text: body,
                },
              ]
            : []
        writeSpatialCanvas(doc, { nodes, edges: [] })

        await saveDocSnapshot(deps, input.canvasId, doc)

        return { canvasId: input.canvasId, imported: true }
      },
    ),
  }
}
