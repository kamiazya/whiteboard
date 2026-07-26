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
 * `x-whiteboard` is a namespaced extension carried on spatial nodes to
 * preserve the original Excalidraw-derived attributes that JSON Canvas 1.0
 * has no room for. Its absence is always valid — a strict JSON Canvas 1.0
 * document parses unchanged.
 *
 * Arrow-decoration attributes (they attach to edges, not nodes, and their
 * strict-export degrade rule is undecided) are deliberately out of scope
 * here and deferred to the slice that builds the strict exporter.
 */
export const xWhiteboardSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('freehand'),
      // Node-local coordinates. Unlike JSON Canvas's node geometry, these
      // are not required to be integers — freehand strokes need sub-pixel
      // precision and this field sits outside the spec's integer rule.
      points: z.array(z.tuple([z.number(), z.number()])).min(2),
      pressures: z.array(z.number().min(0).max(1)).optional(),
      strokeWidth: z.number().positive().optional(),
    })
    .superRefine((value, ctx) => {
      if (value.pressures !== undefined && value.pressures.length !== value.points.length) {
        ctx.addIssue({
          code: 'custom',
          message: 'pressures length must match points length',
          path: ['pressures'],
        })
      }
    }),
  z.object({
    kind: z.literal('shape'),
    shape: z.enum(['rectangle', 'ellipse', 'diamond']),
  }),
  z.object({
    kind: z.literal('embed'),
    canvasId: canvasIdSchema,
    versionRef: z.string().min(1).optional(),
  }),
])

export type XWhiteboard = z.infer<typeof xWhiteboardSchema>

// JSON Canvas 1.0 geometry is specified in integer pixels.
const geometryFieldSchema = z.number().int()

const sharedNodeFieldsSchema = z.object({
  id: nodeIdSchema,
  x: geometryFieldSchema,
  y: geometryFieldSchema,
  width: geometryFieldSchema,
  height: geometryFieldSchema,
  color: canvasColorSchema.optional(),
  'x-whiteboard': xWhiteboardSchema.optional(),
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

export const spatialCanvasSchema = z
  .object({
    // JSON Canvas 1.0 declares both top-level arrays optional; a bare `{}`
    // is a valid (empty) canvas.
    nodes: z.array(spatialNodeSchema).default([]),
    edges: z.array(canvasEdgeSchema).default([]),
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
