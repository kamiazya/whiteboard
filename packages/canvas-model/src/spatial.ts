import { z } from 'zod'
import { canvasIdSchema, nodeIdSchema } from './ids.js'

// JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/): color is either one of
// six numbered presets or a 6-digit hex string.
export const canvasColorSchema = z.union([
  z.enum(['1', '2', '3', '4', '5', '6']),
  z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex color'),
])

export type CanvasColor = z.infer<typeof canvasColorSchema>

/**
 * `x-whiteboard` is a namespaced extension carried on spatial nodes for the
 * one thing JSON Canvas 1.0 has no room for: a node that renders another
 * canvas inline. Its absence is always valid — a strict JSON Canvas 1.0
 * document parses unchanged.
 *
 * The extension is deliberately NOT a general escape hatch for new visual
 * primitives. A capability JSON Canvas cannot express is expressed through
 * an existing node type (a diagram becomes a `file` node pointing at an
 * image) rather than through a variant only this project can read.
 */
export const xWhiteboardSchema = z.object({
  kind: z.literal('embed'),
  canvasId: canvasIdSchema,
  versionRef: z.string().min(1).optional(),
})

export type XWhiteboard = z.infer<typeof xWhiteboardSchema>

// JSON Canvas 1.0 geometry is specified in integer pixels.
const positionFieldSchema = z.number().int()
// Sizes reject negatives. Zero stays valid: JSON Canvas 1.0 does not forbid a
// degenerate box, and a node collapsed on one axis is a layout concern, not a
// parse error.
const sizeFieldSchema = z.number().int().nonnegative()

const sharedNodeFieldsSchema = z.object({
  id: nodeIdSchema,
  x: positionFieldSchema,
  y: positionFieldSchema,
  width: sizeFieldSchema,
  height: sizeFieldSchema,
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

export const spatialNodeSchema = z.discriminatedUnion('type', [
  textNodeSchema,
  fileNodeSchema,
  linkNodeSchema,
  groupNodeSchema,
])

export type SpatialNode = z.infer<typeof spatialNodeSchema>

export const canvasEdgeSchema = z.object({
  id: nodeIdSchema,
  fromNode: nodeIdSchema,
  toNode: nodeIdSchema,
  fromSide: z.enum(['top', 'right', 'bottom', 'left']).optional(),
  toSide: z.enum(['top', 'right', 'bottom', 'left']).optional(),
  fromEnd: z.enum(['none', 'arrow']).optional(),
  toEnd: z.enum(['none', 'arrow']).optional(),
  color: canvasColorSchema.optional(),
  label: z.string().optional(),
})

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
 * be overridable per edge later — that override has to reuse this type, not
 * restate it.
 *
 * `straight` is the default and the only shape JSON Canvas itself implies:
 * direct segments, bending only to clear an obstacle.
 */
export const edgeRoutingStyleSchema = z.enum(['straight', 'orthogonal', 'curved'])

export type EdgeRoutingStyle = z.infer<typeof edgeRoutingStyleSchema>

/**
 * Line jumps draw a small arc where one edge crosses another, so crossing
 * lines stay readable. Canvas-wide today; the same enum is the slot a
 * later per-edge override reuses.
 */
export const lineJumpsSchema = z.enum(['none', 'arc'])

export type LineJumps = z.infer<typeof lineJumpsSchema>

export const edgeRoutingSchema = z.object({
  style: edgeRoutingStyleSchema.optional(),
  lineJumps: lineJumpsSchema.optional(),
})

/**
 * `x-whiteboard` at the CANVAS level — separate from the node-level key of the
 * same name, and holding preferences rather than content.
 *
 * This is not the general escape hatch the node-level key was narrowed away
 * from being. What lives here describes how to DRAW things JSON Canvas already
 * models; a consumer that drops it still renders every edge, just with its own
 * routing. Nothing that changes what the document MEANS belongs here.
 */
export const canvasExtensionSchema = z.object({
  edgeRouting: edgeRoutingSchema.optional(),
})

export type CanvasExtension = z.infer<typeof canvasExtensionSchema>

export const spatialCanvasSchema = z
  .object({
    // JSON Canvas 1.0 declares both top-level arrays optional; a bare `{}`
    // is a valid (empty) canvas.
    nodes: z.array(spatialNodeSchema).default([]),
    edges: z.array(canvasEdgeSchema).default([]),
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

export type SpatialCanvas = z.infer<typeof spatialCanvasSchema>
