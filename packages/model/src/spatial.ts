import { z } from 'zod'
import { extensionFacetsSchema } from './facets.js'
import { documentIdSchema, nodeIdSchema } from './ids.js'
import { integerSchema } from './integer.js'
import { okfActorSchema, okfTimestampSchema } from './trust.js'

// JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/): color is either one of
// six numbered presets or a 6-digit hex string.
export const canvasColorSchema = z.union([
  z.enum(['1', '2', '3', '4', '5', '6']),
  z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex color'),
])

export type CanvasColor = z.infer<typeof canvasColorSchema>

/**
 * What a node, an edge or the canvas may attach beyond its own fields: a
 * namespaced, versioned, schema'd payload bucket ([ADR-0013](../../../docs/contributing/adr/0013-facet-system.md)).
 *
 * It is an ordinary field of the model at each of the three sites. It used to
 * ride inside the JSON Canvas extension key, which is where it still travels
 * on the WIRE — packing it back there is `codec`'s projection, and
 * [ADR-0033](../../../docs/contributing/adr/0033-model-and-format.md) is why
 * the model no longer spells the format's key itself.
 */
const facetsFieldSchema = extensionFacetsSchema.optional().catch(undefined)

/**
 * The document a node shows inline — the one piece of content JSON Canvas 1.0
 * cannot express, and the reason its extension key exists at all.
 */
export const nodeEmbedSchema = z.object({
  documentId: documentIdSchema,
  versionRef: z.string().min(1).optional(),
})

export type NodeEmbed = z.infer<typeof nodeEmbedSchema>

/**
 * Geometry is a REAL number here, where JSON Canvas 1.0 specifies integer
 * pixels ([ADR-0033](../../../docs/contributing/adr/0033-model-and-format.md)).
 *
 * Ink is sub-pixel by nature — a pen reports fractions of a pixel, and a model
 * that rounds before it draws has thrown away what the pen measured. The
 * format's rounding belongs to the PROJECTION, and is codec's ledger's first
 * `degraded` entry.
 *
 * Finite, not merely numeric: `JSON.stringify(Infinity)` is `null` and a NaN
 * corner is not a corner, so widening to a float is not widening to any number
 * at all. Sizes still reject negatives; zero stays valid, because a node
 * collapsed on one axis is a layout concern rather than a parse error.
 *
 * Exported because every payload that ECHOES stored geometry has to accept
 * what the model stores. A read declaring `int` beside a model that holds a
 * fraction does not reject an input — it makes the tool answer with something
 * its own `outputSchema` refuses, which the MCP SDK raises as a failed call.
 */
export const nodePositionSchema = z.number().finite()
export const nodeSizeSchema = z.number().finite().nonnegative()

const sharedNodeFieldsSchema = z.object({
  id: nodeIdSchema,
  x: nodePositionSchema,
  y: nodePositionSchema,
  // Described on the stored shape for the reason the edge sides are: every
  // writer's schema derives from it, and a writer that names a size too
  // small for its text gets the size it named, so the description is where
  // it learns what leaving the size out buys.
  width: nodeSizeSchema.describe('Box width; text wraps at it. Omit it for the default.'),
  height: nodeSizeSchema.describe(
    'Box height. Omit it and a text box is made tall enough for its text; a named one too short for the text is refused with the height it needs.',
  ),
  color: canvasColorSchema.optional(),
  /**
   * The document this node shows inline. Independent of `facets` now: the
   * format's extension key made them two arms of a union, so a node could
   * carry an embed WITH facets or facets alone, and the model inherited a
   * choice the format's shape forced rather than one anything needed.
   */
  embed: nodeEmbedSchema.optional(),
  facets: facetsFieldSchema,
})

const textNodeSchema = sharedNodeFieldsSchema
  .extend({
    type: z.literal('text'),
    text: z.string(),
  })
  .strict()

const fileNodeSchema = sharedNodeFieldsSchema
  .extend({
    type: z.literal('file'),
    file: z.string(),
    subpath: z.string().startsWith('#').optional(),
  })
  .strict()

const linkNodeSchema = sharedNodeFieldsSchema
  .extend({
    type: z.literal('link'),
    url: z.url(),
  })
  .strict()

const groupNodeSchema = sharedNodeFieldsSchema
  .extend({
    type: z.literal('group'),
    label: z.string().optional(),
    background: z.string().optional(),
    backgroundStyle: z.enum(['cover', 'ratio', 'repeat']).optional(),
  })
  .strict()

export const spatialNodeSchema = z.discriminatedUnion('type', [
  textNodeSchema,
  fileNodeSchema,
  linkNodeSchema,
  groupNodeSchema,
])

export type SpatialNode = z.infer<typeof spatialNodeSchema>

/**
 * A hand-placed bend is a point somebody dragged, so the cap is about a
 * payload nobody meant rather than about the geometry: an edge with 64 bends
 * is a defect or an attack, not a drawing.
 */
const MAX_BENDS = 64

const bendPointSchema = z.object({ x: nodePositionSchema, y: nodePositionSchema }).strict()

export const canvasEdgeSchema = z
  .object({
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
     * Points the edge is drawn THROUGH, in canvas coordinates, in order.
     *
     * A native field rather than a plugin facet, by ADR-0033 decision 3's
     * three answers: a person authors them by dragging a handle the core
     * editor draws, the renderer and the editor both read them, and the
     * ledger declares them `extension` — JSON Canvas 1.0 has no waypoint, so
     * a strict reader gets the computed route instead.
     *
     * They lived in `visual.path/v0` until this slice, and that was the
     * ADR's own worked example of the cost the old binding imposed: adding a
     * field to an edge cost a facet definition, an `EdgeRouter` contract and
     * the extraction of `packages/scene`. The seam stays — it was worth
     * building — and the concept comes home.
     *
     * Sub-pixel, like every other coordinate since this slice: the drag no
     * longer has to round before it writes.
     */
    bends: z
      .array(bendPointSchema)
      .min(1)
      .max(MAX_BENDS)
      .optional()
      .describe(
        'Points to draw the line through, in order. Omit it: the route is computed around what is in the way.',
      ),
    /** Edge-target facets (ADR-0013 decision 5's edge slot). */
    facets: facetsFieldSchema,
  })
  .strict()

export type CanvasEdge = z.infer<typeof canvasEdgeSchema>

function findDuplicateId(ids: string[]): string | undefined {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) return id
    seen.add(id)
  }
  return undefined
}

/**
 * How an edge gets from one endpoint to the other once the router has decided
 * it must step around something.
 *
 * Declared on its own rather than inline, because the same choice is meant to
 * be overridable per edge — that override reuses this type, never restates
 * it. Stored as the `visual.edges/v0` facet, never as a field of its own.
 *
 * `straight` is the default and the only shape JSON Canvas itself implies:
 * direct segments, bending only to clear an obstacle.
 */
export const edgeRoutingStyleSchema = z.enum(['straight', 'orthogonal', 'curved'])

export type EdgeRoutingStyle = z.infer<typeof edgeRoutingStyleSchema>

/**
 * Line jumps draw a small arc where one edge crosses another, so crossing
 * lines stay readable. The same enum serves the canvas and a per-edge
 * override alike.
 */
export const lineJumpsSchema = z.enum(['none', 'arc'])

export type LineJumps = z.infer<typeof lineJumpsSchema>

/**
 * The RESOLVED answer to "how are these edges drawn" — what a resolver hands
 * the layout, never a stored shape (the stored shape is the facet).
 */
export const edgeRoutingSchema = z.object({
  style: edgeRoutingStyleSchema.optional(),
  lineJumps: lineJumpsSchema.optional(),
})

/**
 * A comment pinned to the canvas — the annotation layer (ADR-0024).
 *
 * `x`/`y` is the ANCHOR: the point the comment is about, in JSON Canvas
 * integer canvas coordinates. It is deliberately not a bounding box — where
 * the comment's bubble draws is a renderer decision (floating near the
 * anchor), never stored. `targetNodeId` narrows the anchor to "about this
 * node"; a renderer follows the node's current position and falls back to
 * the anchor point when the node is gone. A dangling `targetNodeId` is
 * VALID: a comment may outlive its subject, and the annotation layer must
 * never make the document unreadable.
 *
 * `author` is an OKF actor string (`human:<id>` / `process:<id>`, ADR-0016)
 * so the `human:` prefix keeps its trust meaning across layers; `createdAt`
 * is an OKF timestamp. Both optional: identity is a keeper concern this
 * model does not solve.
 */
const canvasCommentFieldsSchema = z.object({
  id: nodeIdSchema,
  x: integerSchema,
  y: integerSchema,
  text: z.string().min(1),
  author: okfActorSchema.optional(),
  createdAt: okfTimestampSchema.optional(),
  targetNodeId: nodeIdSchema.optional(),
  /**
   * The edge the comment is about, the way `targetNodeId` names a node: a
   * renderer keeps the pin on the edge's routed path and falls back to the
   * anchor point when the edge is gone. Never both — enforced below,
   * because the thread a comment becomes carries both onto one spatial
   * anchor, and `annotationAnchorSchema` refuses an anchor naming two
   * objects. Accepted here and refused there, the comment was written and
   * then silently dropped by every reader.
   */
  targetEdgeId: nodeIdSchema.optional(),
  resolved: z.boolean().optional(),
})

const namesOneTarget = (comment: { targetNodeId?: string; targetEdgeId?: string }): boolean =>
  comment.targetNodeId === undefined || comment.targetEdgeId === undefined
const ONE_TARGET = { message: 'a comment is about a node or an edge, not both' }

export const canvasCommentSchema = canvasCommentFieldsSchema.refine(namesOneTarget, ONE_TARGET)

export type CanvasComment = z.infer<typeof canvasCommentSchema>

/**
 * A comment as a caller DRAFTS it: the id may be minted and the anchor
 * point derived from the node it names, so both are optional here. Declared
 * beside the stored shape because zod refuses `.partial()` over a refined
 * object, and the one-target rule has to hold for a draft too — a draft that
 * escaped it would be stored, become a thread naming two objects, and vanish.
 */
export const canvasCommentDraftSchema = canvasCommentFieldsSchema
  .partial({ id: true, x: true, y: true })
  .refine(namesOneTarget, ONE_TARGET)

export type CanvasCommentDraft = z.infer<typeof canvasCommentDraftSchema>

export const spatialCanvasSchema = z
  .object({
    // JSON Canvas 1.0 declares both top-level arrays optional; a bare `{}`
    // is a valid (empty) canvas.
    // Both arrays default to empty: an empty board is a board.
    nodes: z.array(spatialNodeSchema).default([]),
    edges: z.array(canvasEdgeSchema).default([]),
    /**
     * The comment annotation layer (ADR-0024).
     *
     * NOTE the STORAGE shape differs from this one: the Loro bridge keeps each
     * comment under its own key in a dedicated plane (per-comment CRDT merge,
     * so two peers commenting concurrently both survive) and projects them
     * back here — see loro-adapter's `readSpatialCanvas`.
     *
     * `.catch(undefined)` per BUCKET rather than over the canvas: a malformed
     * comment must cost the comments, not the facets beside them, and neither
     * may cost the board.
     */
    comments: z.array(canvasCommentSchema).optional().catch(undefined),
    /** Canvas-target facets (ADR-0013 decision 5). */
    facets: facetsFieldSchema,
  })
  /**
   * Strict at all three sites, which the format's own schema is NOT and must
   * not be — a JSON Canvas document another tool wrote may carry vendor keys,
   * and refusing it would be wrong. This is the INTERNAL model: a key it does
   * not name is a defect, and a plain `z.object` strips one in silence. That
   * silence is what ADR-0033's migration had to survive, since every reader
   * that still spelled the format's extension key would otherwise have parsed
   * cleanly and lost what it was reading.
   */
  .strict()
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

export type SpatialCanvas = z.infer<typeof spatialCanvasSchema>
