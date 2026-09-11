import { z } from 'zod'
import { canvasEdgeSchema, endpointNode, spatialNodeSchema } from './spatial.js'

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
    /**
     * Present only on a CUT fragment: the cut surface. `boundaryEdges` are
     * the edges the cut severed — exactly one endpoint in the fragment, the
     * other a peer left behind on the source canvas. A same-canvas paste
     * reconnects them to peers that still exist (cut is a move, not a
     * delete); anywhere else the peers are absent and they drop silently.
     * `id` is minted per cut so the reconnect happens on the FIRST paste
     * only — later pastes are plain copies.
     */
    cut: z
      .object({
        id: z.string().min(1),
        boundaryEdges: z.array(canvasEdgeSchema),
      })
      .strict()
      .optional(),
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
      // A point end names nothing, so it is never outside the fragment: it
      // travels with the edge exactly as a coordinate does.
      for (const side of ['from', 'to'] as const) {
        const node = endpointNode(edge[side])
        if (node === undefined || seen.has(node)) continue
        ctx.addIssue({
          code: 'custom',
          message: `edge "${edge.id}" references ${side} node "${node}" outside the fragment`,
          path: ['edges', index, side, 'node'],
        })
      }
    })
    value.cut?.boundaryEdges.forEach((edge, index) => {
      // A boundary edge must CROSS the border: exactly one endpoint inside.
      const inFragment = (['from', 'to'] as const).filter((side) => {
        const node = endpointNode(edge[side])
        return node !== undefined && seen.has(node)
      }).length
      if (inFragment !== 1) {
        ctx.addIssue({
          code: 'custom',
          message: `boundary edge "${edge.id}" must have exactly one endpoint in the fragment`,
          path: ['cut', 'boundaryEdges', index],
        })
      }
    })
  })

export type ClipboardFragment = z.infer<typeof clipboardFragmentSchema>
