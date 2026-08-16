import {
  documentIdSchema,
  type ExtensionFacets,
  extensionFacetsSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-canvas-model'
import { readDocumentKind, readFacets, writeFacets } from '@kamiazya/whiteboard-canvas-workspace'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { assertCanvasInWorkspace } from './assert-canvas-in-workspace.js'
import { loadOrCreateDocument, saveDocumentSnapshot } from './document-io.js'
import { DocumentKindMismatchError } from './errors.js'

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
    documentId: documentIdSchema,
    facets: extensionFacetsSchema,
  })
  .strict()
export type FacetSetInput = z.infer<typeof facetSetInputSchema>

export const facetSetOutputSchema = z
  .object({
    documentId: documentIdSchema,
    facets: extensionFacetsSchema,
  })
  .strict()
export type FacetSetOutput = z.infer<typeof facetSetOutputSchema>

export function createFacetSetTool(deps: ServerDeps) {
  return {
    name: 'wb_facet_set' as const,
    description:
      'Set extension facets on a document. Merges by domain key — a domain the caller omits keeps its stored value.',
    inputSchema: facetSetInputSchema,
    outputSchema: facetSetOutputSchema,
    execute: async (input: FacetSetInput): Promise<FacetSetOutput> => {
      await assertCanvasInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)
      const doc = await loadOrCreateDocument(deps, input.documentId)

      // A facet is OKF frontmatter (ADR-0009 decision 3). A JSON Canvas
      // document has nodes and edges and no frontmatter to put one in, so a
      // facet stored on one is metadata no reader of that format can surface
      // — written, kept, and invisible.
      //
      // A document with no kind is allowed through and NOT declared: unlike
      // an OKF content write this replaces nothing, so it has neither
      // something to lose nor any evidence to offer about the format.
      const kind = readDocumentKind(doc)
      if (kind === 'spatial') {
        throw new DocumentKindMismatchError(
          input.documentId,
          kind,
          'Facets are OKF frontmatter, and a JSON Canvas document has none to hold them. Set them on the markdown document this one refers to, or write its content with wb_document_set.',
        )
      }

      const mergedFacets: ExtensionFacets = { ...readFacets(doc), ...input.facets }
      writeFacets(doc, mergedFacets)

      await saveDocumentSnapshot(deps, input.documentId, doc)

      return { documentId: input.documentId, facets: mergedFacets }
    },
  }
}
