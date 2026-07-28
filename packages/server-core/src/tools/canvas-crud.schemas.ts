import { canvasIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { z } from 'zod'

// Matches WorkspaceTree's own segment validation
// (packages/canvas-workspace/src/workspace-tree.ts) so a segment rejected
// here is rejected identically inside the tree, and vice versa.
const segmentSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?$/, 'invalid segment')

// TreeID (from loro-crdt) has no dedicated Zod schema in canvas-ports; it is
// a nanoid-style opaque string identifying a node within one workspace's
// tree, validated for existence (not shape) by the handler.
const treeIdSchema = z.string().min(1)

export const createCanvasInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    segment: segmentSchema,
    parentId: treeIdSchema.optional(),
  })
  .strict()

export const createCanvasOutputSchema = z
  .object({
    canvasId: canvasIdSchema,
    segment: segmentSchema,
  })
  .strict()

export const getCanvasInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    canvasId: canvasIdSchema,
  })
  .strict()

const canvasDetailSchema = z
  .object({
    canvasId: canvasIdSchema,
    segment: z.string(),
    alias: z.string(),
  })
  .strict()

export const getCanvasOutputSchema = canvasDetailSchema

export const listCanvasesInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
  })
  .strict()

export const listCanvasesOutputSchema = z
  .object({
    canvases: z.array(canvasDetailSchema),
  })
  .strict()

export const deleteCanvasInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    canvasId: canvasIdSchema,
  })
  .strict()

export const deleteCanvasOutputSchema = z
  .object({
    deleted: z.literal(true),
  })
  .strict()
