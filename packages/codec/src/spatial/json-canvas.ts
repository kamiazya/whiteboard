import {
  canvasColorSchema,
  canvasCommentSchema,
  documentIdSchema,
  extensionFacetsSchema,
  integerSchema,
  nodeIdSchema,
  nonnegativeIntegerSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'

/**
 * JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/) as this package writes and
 * reads it: the specified document, plus the single `x-whiteboard` extension
 * key at three sites.
 *
 * It lives in the codec because it is a WIRE shape —
 * [ADR-0033](../../../../docs/contributing/adr/0033-model-and-format.md). Until
 * now it was the product's model, and this declaration is that model's schema
 * LIFTED here rather than a second one written beside it: `json-canvas.test.ts`
 * holds the two structurally identical while they are meant to be, and both of
 * its checks are deleted the moment the model diverges, when the round-trip
 * property takes over the claim.
 *
 * What the schemas below reuse from the model is vocabulary the two genuinely
 * share — an id, a colour, a comment, the facet key grammar. What they declare
 * is the DOCUMENT: which fields the format states, and where it leaves room.
 */

/**
 * A facets-only `x-whiteboard`: the payload bucket and nothing else — the
 * node variant without an embed. `.strict()`, so a broken embed on a node
 * fails this arm too rather than being silently stripped down to its facets.
 *
 * The EDGE site used to share it and no longer does: since ADR-0033 slice 4
 * an edge also carries its bends, so it has a declaration of its own.
 */
const facetsOnlyExtensionSchema = z
  .object({
    facets: extensionFacetsSchema.optional().catch(undefined),
  })
  .strict()

/**
 * `x-whiteboard` on a NODE. Two arms: an embedded document — the one piece of
 * content JSON Canvas 1.0 cannot express — or node-target facets alone.
 */
export const xWhiteboardSchema = z.union([
  z.object({
    kind: z.literal('embed'),
    /**
     * The DOCUMENT this node embeds. Written into exported JSON Canvas files
     * and published as `docs/reference/x-whiteboard.schema.json`, so this is a
     * format contract and not only a name.
     */
    documentId: documentIdSchema,
    versionRef: z.string().min(1).optional(),
    facets: extensionFacetsSchema.optional().catch(undefined),
  }),
  facetsOnlyExtensionSchema,
])

export type XWhiteboard = z.infer<typeof xWhiteboardSchema>

// JSON Canvas 1.0 geometry is specified in integer pixels.
const positionFieldSchema = integerSchema
// Sizes reject negatives. Zero stays valid: JSON Canvas 1.0 does not forbid a
// degenerate box, and a node collapsed on one axis is a layout concern, not a
// parse error.
const sizeFieldSchema = nonnegativeIntegerSchema

const sharedNodeFieldsSchema = z.object({
  id: nodeIdSchema,
  x: positionFieldSchema,
  y: positionFieldSchema,
  // Described on the stored shape for the reason the edge sides are: every
  // writer's schema derives from it, and a writer that names a size too
  // small for its text gets the size it named, so the description is where
  // it learns what leaving the size out buys.
  width: sizeFieldSchema.describe('Box width; text wraps at it. Omit it for the default.'),
  height: sizeFieldSchema.describe(
    'Box height. Omit it and a text box is made tall enough for its text; a named one too short for the text is refused with the height it needs.',
  ),
  color: canvasColorSchema.optional(),
  // `.catch` rather than a reject: an unrecognised extension payload — a
  // variant this project has dropped, or one a future version writes — must
  // not make the whole canvas unreadable. The node survives; only the
  // extension is lost, which is the same outcome a strict JSON Canvas
  // consumer already gets.
  'x-whiteboard': xWhiteboardSchema.optional().catch(undefined),
})

const textNodeSchema = sharedNodeFieldsSchema.extend({
  type: z.literal('text'),
  text: z.string(),
})

const fileNodeSchema = sharedNodeFieldsSchema.extend({
  type: z.literal('file'),
  file: z.string(),
  subpath: z.string().startsWith('#').optional(),
})

const linkNodeSchema = sharedNodeFieldsSchema.extend({
  type: z.literal('link'),
  url: z.url(),
})

const groupNodeSchema = sharedNodeFieldsSchema.extend({
  type: z.literal('group'),
  label: z.string().optional(),
  background: z.string().optional(),
  backgroundStyle: z.enum(['cover', 'ratio', 'repeat']).optional(),
})

/** The four node types JSON Canvas 1.0 defines, and no fifth. */
export const jsonCanvasNodeSchema = z.discriminatedUnion('type', [
  textNodeSchema,
  fileNodeSchema,
  linkNodeSchema,
  groupNodeSchema,
])

export type JsonCanvasNode = z.infer<typeof jsonCanvasNodeSchema>

/**
 * `x-whiteboard` on an EDGE: the facet bucket, plus the bends the edge is
 * drawn through.
 *
 * `bends` is the one piece of edge CONTENT JSON Canvas 1.0 cannot express —
 * the format has no waypoint — so a strict reader gets the same two endpoints
 * and the computed route between them. Integer here, like every other
 * coordinate the format states, and rounded on the way out.
 */
export const edgeExtensionSchema = z
  .object({
    facets: extensionFacetsSchema.optional().catch(undefined),
    bends: z
      .array(z.object({ x: z.number().int(), y: z.number().int() }))
      .min(1)
      .optional()
      .catch(undefined),
  })
  .strict()

/** An edge, which JSON Canvas 1.0 requires to run between two NODES. */
const jsonCanvasEdgeSchema = z.object({
  id: nodeIdSchema,
  fromNode: nodeIdSchema,
  toNode: nodeIdSchema,
  // Described here, on the stored shape, because every writer's schema is
  // derived from it: the description says what leaving a side out buys,
  // since a router that honours a pinned side draws whatever the pin makes
  // it draw.
  fromSide: z
    .enum(['top', 'right', 'bottom', 'left'])
    .optional()
    .describe(
      'The side the edge leaves from. Omit it: the router picks the side that keeps the line clear of other boxes, and a named side is kept even through one.',
    ),
  toSide: z
    .enum(['top', 'right', 'bottom', 'left'])
    .optional()
    .describe('The side the edge arrives at. Omit it for the same reason as fromSide.'),
  fromEnd: z.enum(['none', 'arrow']).optional(),
  toEnd: z.enum(['none', 'arrow']).optional(),
  color: canvasColorSchema.optional(),
  label: z.string().optional(),
  /**
   * Edge-target facets (ADR-0013 decision 5's edge slot) and the edge's
   * bends. Unlike a node's key this one never carries an embed: what an edge
   * holds that the format cannot state is geometry, not content.
   */
  'x-whiteboard': edgeExtensionSchema.optional().catch(undefined),
})

export type JsonCanvasEdge = z.infer<typeof jsonCanvasEdgeSchema>

/**
 * `x-whiteboard` at the DOCUMENT root — the annotation layer and the canvas's
 * own facets. A consumer that drops it still holds the complete content.
 *
 * `.catch(undefined)` on each BUCKET, not on the whole extension: a malformed
 * comment must cost the comments, not the preferences beside them.
 */
export const canvasExtensionSchema = z.object({
  comments: z.array(canvasCommentSchema).optional().catch(undefined),
  facets: extensionFacetsSchema.optional().catch(undefined),
})

export const jsonCanvasDocumentSchema = z
  .object({
    // JSON Canvas 1.0 declares both top-level arrays optional; a bare `{}`
    // is a valid (empty) canvas.
    nodes: z.array(jsonCanvasNodeSchema).default([]),
    edges: z.array(jsonCanvasEdgeSchema).default([]),
    // `.catch` for the same reason the node-level key uses it: a preference
    // written by another version must cost the preference, never the canvas.
    'x-whiteboard': canvasExtensionSchema.optional().catch(undefined),
  })
  .superRefine((value, ctx) => {
    const duplicateNodeId = findDuplicateId(value.nodes.map((node) => node.id))
    if (duplicateNodeId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate node id "${duplicateNodeId}"`,
        path: ['nodes'],
      })
    }

    const duplicateEdgeId = findDuplicateId(value.edges.map((edge) => edge.id))
    if (duplicateEdgeId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate edge id "${duplicateEdgeId}"`,
        path: ['edges'],
      })
    }

    const nodeIds = new Set(value.nodes.map((node) => node.id))
    value.edges.forEach((edge, index) => {
      if (!nodeIds.has(edge.fromNode)) {
        ctx.addIssue({
          code: 'custom',
          message: `edge "${edge.id}" references nonexistent fromNode "${edge.fromNode}"`,
          path: ['edges', index, 'fromNode'],
        })
      }
      if (!nodeIds.has(edge.toNode)) {
        ctx.addIssue({
          code: 'custom',
          message: `edge "${edge.id}" references nonexistent toNode "${edge.toNode}"`,
          path: ['edges', index, 'toNode'],
        })
      }
    })
  })

export type JsonCanvasDocument = z.infer<typeof jsonCanvasDocumentSchema>

function findDuplicateId(ids: string[]): string | undefined {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) return id
    seen.add(id)
  }
  return undefined
}
