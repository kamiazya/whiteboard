import {
  documentIdSchema,
  documentKindSchema,
  documentPathSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-canvas-model'
import { z } from 'zod'

export const createCanvasInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    path: documentPathSchema.describe(
      'Where the document goes, as a slash-separated path from the workspace root. Hierarchy is the path: `plan/sub` sits under `plan`, and no separate parent id is involved.',
    ),
    kind: documentKindSchema.describe(
      'What the document is. `markdown` serialises as OKF, `spatial` as JSON Canvas. Required: the format follows from the document rather than from a read parameter, so a document created without one cannot be read back.',
    ),
    name: z
      .string()
      .optional()
      .describe(
        'What a human reads. Free text, unlike `path`, which is a path and decides placement. Omit it and the document has no name of its own — a reader falls back to the segment rather than being handed the path as a title.',
      ),
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
    documentId: documentIdSchema,
    path: documentPathSchema,
  })
  .strict()

export const getCanvasInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
  })
  .strict()

const canvasDetailSchema = z
  .object({
    documentId: documentIdSchema,
    path: documentPathSchema,
    // Absent rather than defaulted to the path's last segment: a reader that
    // wants that fallback can choose it, and a listing that invents one reads
    // as if somebody typed the path as the title.
    name: z.string().optional(),
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
    documentId: documentIdSchema,
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
  'Create an empty document at a path in a workspace. The path is the placement: `plan/sub` sits under `plan`.'
export const WB_DOCUMENT_LIST_DESCRIPTION =
  'List the documents in a workspace with their placement. An unknown workspace is an error rather than an empty list, so a mistyped workspaceId cannot be mistaken for a genuinely empty workspace.'
export const WB_DOCUMENT_RESOLVE_DESCRIPTION =
  'Resolve a document id to its path. Returns placement only, never content.'
export const WB_DOCUMENT_DELETE_DESCRIPTION =
  'Delete a document. Fails if documents sit below it — deletion is not recoverable, so the caller names what it destroys.'
