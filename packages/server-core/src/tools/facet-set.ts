import {
  readDocumentKind,
  readFacets,
  readSpatialCanvas,
  writeFacets,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  documentIdSchema,
  type ExtensionFacets,
  extensionFacetsSchema,
  nodeIdSchema,
  type SpatialNode,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { loadOrCreateDocument, saveDocumentSnapshot } from './document-io.js'
import { DocumentKindMismatchError, FacetWriteRejectedError, NodeNotFoundError } from './errors.js'

/**
 * `extensionFacetsSchema` already enforces the `{namespace}.{name}/v{n}` key
 * pattern (model's `EXTENSION_FACET_KEY_PATTERN`), so a caller can
 * never use this tool to set a core facet (`type`/`title`/`tags`/`view`) or
 * the raw `facets` root key itself — those don't match the pattern and are
 * rejected at parse time rather than needing a separate namespace guard.
 */
export const facetSetInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
    /**
     * Present: the write targets this NODE of a spatial document (facets
     * land in the node's x-whiteboard facets bucket). Absent: the write
     * targets the document itself (markdown only).
     */
    nodeId: nodeIdSchema.optional(),
    /**
     * A null value DELETES that facet; anything else sets it. Deletion is
     * an input-only tombstone — stored buckets never hold null.
     */
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
      'Set facets on a document, or — with nodeId — on one node of a spatial document. Merges by facet key: an omitted key keeps its stored value, a null value deletes the key. Registered facets are validated against their schema and their declared targets.',
    inputSchema: facetSetInputSchema,
    outputSchema: facetSetOutputSchema,
    execute: async (input: FacetSetInput): Promise<FacetSetOutput> => {
      await assertDocumentInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)
      const doc = await loadOrCreateDocument(deps, input.documentId)
      const kind = readDocumentKind(doc)
      const registry = deps.facetRegistry ?? bundledFacetRegistry

      // Write-side validation (ADR-0013 decision 6): a REGISTERED facet's
      // payload must satisfy its schema, its key must be the current
      // version, and its declared targets must include what this write
      // targets — 'node' when nodeId is given, 'document' otherwise.
      // Unregistered facets pass through unvalidated (round-trip safety).
      // Registered payloads are stored as the schema's PARSED value. A null
      // payload deletes the key — deletion needs no target or schema check.
      const requiredTarget = input.nodeId === undefined ? 'document' : 'node'
      const sets: Record<string, unknown> = {}
      const deletions: string[] = []
      for (const [key, payload] of Object.entries(input.facets)) {
        if (payload === null) {
          deletions.push(key)
          continue
        }
        const targets = registry.targetsOf(key)
        if (targets !== undefined && !targets.includes(requiredTarget)) {
          throw new FacetWriteRejectedError(
            key,
            `its targets are [${targets.join(', ')}], and this write targets a ${requiredTarget}`,
          )
        }
        const result = registry.validateFacetWrite(key, payload)
        if (!result.ok) {
          throw new FacetWriteRejectedError(key, result.message)
        }
        sets[key] = result.value
      }

      if (input.nodeId !== undefined) {
        const nodeId = input.nodeId
        // A kind-less document (freshly created, nothing declared) has no
        // canvas, so the node cannot exist — report THAT, rather than
        // fabricating a kind for the mismatch message.
        if (kind === undefined) {
          throw new NodeNotFoundError(input.documentId, nodeId)
        }
        if (kind !== 'spatial') {
          throw new DocumentKindMismatchError(
            input.documentId,
            kind,
            "Node-target facets live on a spatial document's node. Omit nodeId to set facets on a markdown document.",
          )
        }
        const canvas = readSpatialCanvas(doc)
        const node = canvas.nodes.find((candidate) => candidate.id === nodeId)
        if (node === undefined) {
          throw new NodeNotFoundError(input.documentId, nodeId)
        }
        const merged: ExtensionFacets = { ...node['x-whiteboard']?.facets, ...sets }
        for (const key of deletions) delete merged[key]
        const { facets: _replaced, ...extensionRest } = node['x-whiteboard'] ?? {}
        const nextExtension =
          Object.keys(merged).length === 0 ? extensionRest : { ...extensionRest, facets: merged }
        const { 'x-whiteboard': _extension, ...nodeRest } = node
        const nextNode = (
          Object.keys(nextExtension).length === 0
            ? nodeRest
            : { ...nodeRest, 'x-whiteboard': nextExtension }
        ) as SpatialNode
        writeSpatialCanvas(doc, {
          ...canvas,
          nodes: canvas.nodes.map((candidate) => (candidate.id === nodeId ? nextNode : candidate)),
        })
        await saveDocumentSnapshot(deps, input.documentId, doc)
        return { documentId: input.documentId, facets: merged }
      }

      // A facet is OKF frontmatter (ADR-0009 decision 3). A JSON Canvas
      // document has nodes and edges and no frontmatter to put one in, so a
      // facet stored on one is metadata no reader of that format can surface
      // — written, kept, and invisible.
      //
      // A document with no kind is allowed through and NOT declared: unlike
      // an OKF content write this replaces nothing, so it has neither
      // something to lose nor any evidence to offer about the format.
      if (kind === 'spatial') {
        throw new DocumentKindMismatchError(
          input.documentId,
          kind,
          'Facets are OKF frontmatter, and a JSON Canvas document has none to hold them. Pass nodeId to set node-target facets, set them on the markdown document this one refers to, or write its content with wb_document_set.',
        )
      }

      const mergedFacets: ExtensionFacets = { ...readFacets(doc), ...sets }
      for (const key of deletions) delete mergedFacets[key]
      writeFacets(doc, mergedFacets)

      await saveDocumentSnapshot(deps, input.documentId, doc)

      return { documentId: input.documentId, facets: mergedFacets }
    },
  }
}
