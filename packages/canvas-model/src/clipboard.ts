import { z } from 'zod'
import { canvasEdgeSchema, spatialNodeSchema } from './spatial.js'

/**
 * The typed clipboard envelope for copy/paste of canvas fragments
 * (editor-completeness plan, user decisions 2026-08-09): a FULL
 * spatialCanvasSchema-shaped subset plus inline file assets, so a
 * cross-canvas paste can re-materialize images instead of carrying
 * dangling references (Excalidraw's elements+files precedent). The
 * discriminant `type` keeps foreign JSON from parsing as ours, and
 * `version` is a literal so a future breaking change is a new literal
 * union member, not a silent drift.
 */
export const clipboardFileAssetSchema = z
  .object({
    mimeType: z.string().min(1),
    dataBase64: z.string(),
  })
  .strict()

export type ClipboardFileAsset = z.infer<typeof clipboardFileAssetSchema>

export const clipboardFragmentSchema = z
  .object({
    type: z.literal('whiteboard/clipboard'),
    version: z.literal(1),
    nodes: z.array(spatialNodeSchema),
    edges: z.array(canvasEdgeSchema),
    /** Inline assets keyed by the file-node `file` reference they carry. */
    files: z.record(z.string(), clipboardFileAssetSchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Same integrity rules as spatialCanvasSchema: unique ids, and every
    // edge endpoint present IN THE FRAGMENT (a fragment is self-contained
    // by construction — the copy builder only includes fully-selected
    // edges, and paste remints against exactly this node set).
    const seen = new Set<string>()
    for (const node of value.nodes) {
      if (seen.has(node.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate node id "${node.id}"`,
          path: ['nodes'],
        })
        break
      }
      seen.add(node.id)
    }
    const edgeIds = new Set<string>()
    value.edges.forEach((edge, index) => {
      if (edgeIds.has(edge.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate edge id "${edge.id}"`, path: ['edges'] })
      }
      edgeIds.add(edge.id)
      if (!seen.has(edge.fromNode)) {
        ctx.addIssue({
          code: 'custom',
          message: `edge "${edge.id}" references fromNode "${edge.fromNode}" outside the fragment`,
          path: ['edges', index, 'fromNode'],
        })
      }
      if (!seen.has(edge.toNode)) {
        ctx.addIssue({
          code: 'custom',
          message: `edge "${edge.id}" references toNode "${edge.toNode}" outside the fragment`,
          path: ['edges', index, 'toNode'],
        })
      }
    })
  })

export type ClipboardFragment = z.infer<typeof clipboardFragmentSchema>
