import {
  canvasIdSchema,
  type ExtensionFacets,
  extensionFacetsSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-canvas-model'
import { readFacets, writeFacets } from '@kamiazya/whiteboard-canvas-workspace'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadOrCreateCanvasDoc, saveDocSnapshot } from './canvas-doc-io.js'
import { assertCanvasInWorkspace } from './workspace-tree-io.js'

/**
 * `extensionFacetsSchema` already enforces the `{domain}/{version}` key
 * pattern (canvas-model's `EXTENSION_FACET_KEY_PATTERN`), so a caller can
 * never use this tool to set a core facet (`type`/`title`/`tags`/`view`) or
 * the raw `facets` root key itself — those don't match the pattern and are
 * rejected at parse time rather than needing a separate namespace guard.
 */
export const facetSetInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    canvasId: canvasIdSchema,
    facets: extensionFacetsSchema,
  })
  .strict()
export type FacetSetInput = z.infer<typeof facetSetInputSchema>

export const facetSetOutputSchema = z
  .object({
    canvasId: canvasIdSchema,
    facets: extensionFacetsSchema,
  })
  .strict()
export type FacetSetOutput = z.infer<typeof facetSetOutputSchema>

export function createFacetSetTool(deps: ServerDeps) {
  return {
    name: 'wb_wb_facet_set' as const,
    inputSchema: facetSetInputSchema,
    outputSchema: facetSetOutputSchema,
    execute: async (input: FacetSetInput): Promise<FacetSetOutput> => {
      await assertCanvasInWorkspace(deps.canvasDocStore, input.workspaceId, input.canvasId)
      const doc = await loadOrCreateCanvasDoc(deps, input.canvasId)

      const mergedFacets: ExtensionFacets = { ...readFacets(doc), ...input.facets }
      writeFacets(doc, mergedFacets)

      await saveDocSnapshot(deps, input.canvasId, doc)

      return { canvasId: input.canvasId, facets: mergedFacets }
    },
  }
}
