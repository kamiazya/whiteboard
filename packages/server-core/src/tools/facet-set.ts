import {
  canvasIdSchema,
  extensionFacetsSchema,
  type ExtensionFacets,
} from '@kamiazya/whiteboard-canvas-model'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import { readFacets, writeFacets } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'

/**
 * `extensionFacetsSchema` already enforces the `{domain}/{version}` key
 * pattern (canvas-model's `EXTENSION_FACET_KEY_PATTERN`), so a caller can
 * never use this tool to set a core facet (`type`/`title`/`tags`/`view`) or
 * the raw `facets` root key itself — those don't match the pattern and are
 * rejected at parse time rather than needing a separate namespace guard.
 */
export const facetSetInputSchema = z
  .object({
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

/**
 * A single chunk always fits Loro's snapshot output for a facets-only
 * mutation; this cap only matters once a store/sync implementation enforces
 * its own message-size limit, which is out of this shared layer's scope.
 */
const SNAPSHOT_MAX_CHUNK_BYTES = 1_000_000

export function createFacetSetTool(deps: ServerDeps) {
  return {
    name: 'facet_set' as const,
    inputSchema: facetSetInputSchema,
    outputSchema: facetSetOutputSchema,
    async execute(input: FacetSetInput): Promise<FacetSetOutput> {
      const docRef = { kind: 'canvas' as const, canvasId: input.canvasId }
      const existing = await deps.canvasDocStore.loadSnapshot({ docRef })

      const doc = new LoroDoc()
      if (existing !== null) {
        doc.import(reassembleSnapshot(existing.manifest, existing.chunks))
      }

      const mergedFacets: ExtensionFacets = { ...readFacets(doc), ...input.facets }
      writeFacets(doc, mergedFacets)

      const { manifest, chunks } = chunkSnapshot(
        doc.export({ mode: 'snapshot' }),
        SNAPSHOT_MAX_CHUNK_BYTES,
      )
      await deps.canvasDocStore.saveSnapshot({
        docRef,
        manifest,
        chunks,
        frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
      })

      return { canvasId: input.canvasId, facets: mergedFacets }
    },
  }
}
