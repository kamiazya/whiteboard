import { documentIdSchema, documentPathSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'

/**
 * Fields every new document has, whatever its kind.
 */
const documentCreateCommonShape = {
  workspaceId: workspaceIdSchema,
  path: documentPathSchema.describe(
    'Where the document goes, as a slash-separated path from the workspace root. Hierarchy is the path: `plan/sub` sits under `plan`, and no separate parent id is involved.',
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
}

/**
 * A discriminated union on `kind` rather than one flat object, because the
 * two kinds do not accept the same content and a flat shape could only
 * check that at runtime — after a caller had already been told the call was
 * well-formed.
 *
 * Only `markdown` takes a body here. A spatial document's content is JSON
 * Canvas, built through `wb_canvas_edit`, whose batch shape exists precisely
 * so a diagram is not assembled one call at a time; funnelling a canvas
 * through a string on this tool would be a second, worse way to do it.
 */
export const wbDocumentCreateInputSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...documentCreateCommonShape,
        kind: z
          .literal('markdown')
          .describe('An OKF markdown document. Serialises as OKF Markdown.'),
        markdown: z
          .string()
          .optional()
          .describe(
            'The document, as OKF Markdown — frontmatter and body. Optional; without it the document is created empty, which is what a caller wants when the content comes from somewhere else. Supplying it here saves the separate `wb_document_set` that every "create a note" flow otherwise needs.',
          ),
      })
      .strict(),
    z
      .object({
        ...documentCreateCommonShape,
        kind: z
          .literal('spatial')
          .describe(
            'A JSON Canvas document. Its content is built with `wb_canvas_edit`, so this tool takes no body for it.',
          ),
      })
      .strict(),
  ])
  .describe(
    'Creates one document. The format follows from the document rather than from a read parameter, so `kind` is required: a document created without one cannot be read back.',
  )

export const wbDocumentCreateOutputSchema = z
  .object({
    documentId: documentIdSchema,
    path: documentPathSchema,
  })
  .strict()

export const wbDocumentResolveInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
  })
  .strict()

const documentDetailSchema = z
  .object({
    documentId: documentIdSchema,
    path: documentPathSchema,
    // Absent rather than defaulted to the path's last segment: a reader that
    // wants that fallback can choose it, and a listing that invents one reads
    // as if somebody typed the path as the title.
    name: z.string().optional(),
  })
  .strict()

export const wbDocumentResolveOutputSchema = documentDetailSchema

export const wbDocumentListInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
  })
  .strict()

export const wbDocumentListOutputSchema = z
  .object({
    documents: z.array(documentDetailSchema),
  })
  .strict()

export const wbDocumentDeleteInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
  })
  .strict()

export const wbDocumentDeleteOutputSchema = z
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
