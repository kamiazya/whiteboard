import {
  canvasIdSchema,
  canvasKindSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-canvas-model'
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
    kind: canvasKindSchema.describe(
      'What the document is. `markdown` serialises as OKF, `spatial` as JSON Canvas. Required: the format follows from the document rather than from a read parameter, so a document created without one cannot be read back.',
    ),
    parentId: treeIdSchema.optional(),
    // Workspaces are never materialized implicitly: a typo'd or hallucinated
    // workspaceId must fail loudly instead of silently writing data into a
    // workspace nobody asked for. Creating a genuinely new workspace is an
    // explicit opt-in via this flag.
    createWorkspace: z
      .boolean()
      .optional()
      .describe('Set true to create the workspace if it does not exist yet.'),
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

/**
 * Tool descriptions live beside the schemas they describe so metadata and
 * validation cannot drift. These four register with literal names rather
 * than through a tool object, so they have nowhere else to live.
 */
export const WB_DOCUMENT_CREATE_DESCRIPTION =
  'Create an empty document in a workspace and place it in the workspace tree.'
export const WB_DOCUMENT_LIST_DESCRIPTION =
  'List the documents in a workspace with their placement. An unknown workspace is an error rather than an empty list, so a mistyped workspaceId cannot be mistaken for a genuinely empty workspace.'
export const WB_DOCUMENT_RESOLVE_DESCRIPTION =
  'Resolve a document id to its placement — its segment and derived alias. Returns placement only, never content.'
export const WB_DOCUMENT_DELETE_DESCRIPTION =
  'Delete a document and remove it from the workspace tree.'
