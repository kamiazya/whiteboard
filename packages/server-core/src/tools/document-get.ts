import { okfMarkdownFrontmatterSchema } from '@kamiazya/whiteboard-codec'
import { readDocumentKind } from '@kamiazya/whiteboard-loro-adapter'
import { documentIdSchema, documentKindSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadOrCreateDocument } from './document-io.js'
import { exportJsonCanvas } from './export-json-canvas.js'
import { exportOkf } from './export-okf.js'

/**
 * 20 is a ceiling on one request, and it is a JUDGEMENT rather than a
 * measurement: this tool returns UNTRUNCATED content, so N multiplies a
 * payload that is already unbounded per document. `wb_canvas_snapshot`
 * exists precisely because a single board can be too large to read whole,
 * and surveying many documents is `wb_document_list` plus that, not this.
 */
const MAX_DOCUMENTS = 20

const documentGetInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentIds: z.array(documentIdSchema).min(1).max(MAX_DOCUMENTS),
    options: z
      .object({
        strict: z
          .boolean()
          .default(false)
          .describe(
            'JSON Canvas only: drop the x-whiteboard extension so the output is plain JSON Canvas 1.0.',
          ),
      })
      .strict()
      .optional(),
  })
  .strict()
export type DocumentGetInput = z.infer<typeof documentGetInputSchema>

const readDocumentSchema = z
  .object({
    documentId: documentIdSchema,
    kind: documentKindSchema,
    content: z.string(),
    // Present only for a markdown document. Frontmatter is OKF's, and a JSON
    // Canvas document has none (ADR-0009 decision 3) — an always-present
    // field would have to invent one.
    frontmatter: okfMarkdownFrontmatterSchema.optional(),
  })
  .strict()

const documentGetOutputSchema = z
  .object({
    /** In the order asked for, minus anything that landed in `failed`. */
    documents: z.array(readDocumentSchema),
    /**
     * A document this call could not read, and why. Partial rather than
     * all-or-nothing because a hard failure would send the caller
     * binary-searching for the bad id — more calls than the batch saved.
     * Only a per-DOCUMENT failure lands here; anything systemic (a store
     * that will not answer) still fails the whole call, because reporting
     * an outage as twenty document-shaped failures hides it.
     */
    failed: z.array(z.object({ documentId: documentIdSchema, reason: z.string() }).strict()),
  })
  .strict()
export type DocumentGetOutput = z.infer<typeof documentGetOutputSchema>
type ReadDocument = z.infer<typeof readDocumentSchema>

class DocumentKindUnknownError extends Error {
  constructor(public readonly documentId: string) {
    super(
      `Document ${documentId} records no kind, so there is no format to read it as ` +
        '(checked both the document itself and its index row). ' +
        'Documents created before kinds existed are affected. Editing one records a kind: ' +
        'wb_canvas_edit records it as spatial and keeps what it holds, ' +
        'and wb_document_set records it as markdown — which replaces its content, so it is ' +
        'refused unless the document is empty.',
    )
    this.name = 'DocumentKindUnknownError'
  }
}

/**
 * The read half of ADR-0009 decision 4: the format follows from the document.
 *
 * This replaces the two exporters it now calls. They both ran on ANY
 * document — the OKF one filling in a placeholder `type` for documents that
 * had never carried frontmatter — so a caller could ask a diagram for its
 * markdown and get something back. Which format you get is now the
 * document's answer, not the caller's.
 */
export function createDocumentGetTool(deps: ServerDeps) {
  return {
    name: 'wb_document_get' as const,
    description:
      'Read one or more documents, each in its own format: a markdown document as OKF Markdown, a spatial one as JSON Canvas. The format is not a parameter — it follows from what each document was created as, and `kind` on each result says which you got. A document that cannot be read is reported in `failed` rather than failing the whole call.',
    inputSchema: documentGetInputSchema,
    outputSchema: documentGetOutputSchema,
    async execute(input: DocumentGetInput): Promise<DocumentGetOutput> {
      const documents: ReadDocument[] = []
      const failed: DocumentGetOutput['failed'] = []
      // Serial rather than Promise.all: the store behind this is SQLite in
      // the daemon, and concurrent reads of one file are what SQLITE_BUSY is
      // made of (the same reason GET /api/workspaces sequences its own).
      for (const documentId of input.documentIds) {
        try {
          documents.push(await readOne(deps, input, documentId))
        } catch (error) {
          // Only the one failure that is genuinely ABOUT this document.
          // Everything else propagates.
          if (!(error instanceof DocumentKindUnknownError)) throw error
          failed.push({ documentId, reason: error.message })
        }
      }
      return { documents, failed }
    },
  }
}

async function readOne(
  deps: ServerDeps,
  input: DocumentGetInput,
  documentId: string,
): Promise<ReadDocument> {
  const doc = await loadOrCreateDocument(deps, input.workspaceId, documentId)
  // A document created before kinds existed carries none on its own Loro
  // doc. Its index row, written at creation time, may still have one —
  // consult it before refusing. This is a read-only fallback: the kind
  // is never written back onto the doc or the row.
  const kind =
    readDocumentKind(doc) ??
    (await deps.documentIndex.resolveDocumentById({ workspaceId: input.workspaceId, documentId }))
      ?.kind
  if (kind === undefined) {
    throw new DocumentKindUnknownError(documentId)
  }
  if (kind === 'markdown') {
    const { markdown, frontmatter } = await exportOkf(deps, {
      workspaceId: input.workspaceId,
      documentId,
    })
    return { documentId, kind, content: markdown, ...(frontmatter ? { frontmatter } : {}) }
  }
  const { json } = await exportJsonCanvas(deps, {
    workspaceId: input.workspaceId,
    documentId,
    ...(input.options ? { options: input.options } : {}),
  })
  return { documentId, kind, content: json }
}
