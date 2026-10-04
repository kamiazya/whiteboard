import { okfMarkdownFrontmatterSchema } from '@kamiazya/whiteboard-codec'
import { readAnnotations, readDocumentKind, readProposals } from '@kamiazya/whiteboard-loro-adapter'
import {
  commentThreadSchema,
  type DocumentKind,
  documentIdSchema,
  documentKindSchema,
  proposalSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { loadOrCreateDocument } from '../document-io.js'
import type { ServerDeps } from '../server-deps.js'
import { DocumentSerializeError } from './errors.js'
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

// `facetsRaw` is the parser's bucket for root keys it does not interpret, so a
// note with `created: 2020-01-02` reads back as `facetsRaw.created`: a reader
// of the schema cannot otherwise tell it from a field the server defines.
const documentFrontmatterSchema = okfMarkdownFrontmatterSchema.extend({
  facetsRaw: okfMarkdownFrontmatterSchema.shape.facetsRaw.describe(
    'Root frontmatter keys the server does not interpret, kept verbatim under their own names (a note with `created: 2020-01-02` reads back as facetsRaw.created).',
  ),
})

const readDocumentSchema = z
  .object({
    documentId: documentIdSchema,
    kind: documentKindSchema,
    content: z.string(),
    // Present only for a markdown document. Frontmatter is OKF's, and a JSON
    // Canvas document has none (ADR-0009 decision 3) — an always-present
    // field would have to invent one.
    frontmatter: documentFrontmatterSchema.optional(),
    // The annotation layer, whole, on either kind: neither format's `content`
    // carries it, so this is the one read an agent has of what people said
    // about a document. Absent when there is none, so an uncommented
    // document costs no bytes.
    threads: z.array(commentThreadSchema).optional(),
    // Changes proposed to the document, each with its status, so an agent
    // can learn whether what it proposed was adopted or dismissed. Absent
    // when there are none.
    proposals: z.array(proposalSchema).optional(),
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
        "and `wb_workspace_edit`'s `document.set` op records it as markdown — which replaces its " +
        'content, so it is ' +
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
      'Read one or more documents, each in its own format: a markdown document as OKF Markdown, a spatial one as JSON Canvas. The format is not a parameter — it follows from what each document was created as, and `kind` on each result says which you got. Each result carries the comment `threads` on the document in full (anchor, status, every message with author and time), and the `proposals` made to it with the status of each change (open, adopted or dismissed), when it has any. A document that cannot be read is reported in `failed` rather than failing the whole call.',
    inputSchema: documentGetInputSchema,
    outputSchema: documentGetOutputSchema,
    async execute(input: DocumentGetInput): Promise<DocumentGetOutput> {
      const documents: ReadDocument[] = []
      const failed: DocumentGetOutput['failed'] = []
      // Serial rather than Promise.all: the store behind this is SQLite in
      // the daemon, and concurrent reads of one file are what SQLITE_BUSY is
      // made of (the same reason GET /api/workspaces sequences its own).
      for (const documentId of input.documentIds) {
        // Placement first: `loadOrCreateDocument` conjures an empty document
        // for any id, so without this an id that never existed reads as a
        // document that lost its kind — the wrong cause, with a repair that
        // does not apply to it.
        const entry = await deps.documentIndex.resolveDocumentById({
          workspaceId: input.workspaceId,
          documentId,
        })
        if (entry === null) {
          failed.push({
            documentId,
            reason: `Document not found: ${documentId}. This workspace holds no document with that id; wb_document_list shows the ones it does.`,
          })
          continue
        }
        try {
          documents.push(await readOne(deps, input, documentId, entry.kind))
        } catch (error) {
          // Only the failures that are genuinely ABOUT this document: it has
          // no kind to read it by, or its content has no representation in
          // that format. Everything else propagates.
          if (
            !(error instanceof DocumentKindUnknownError || error instanceof DocumentSerializeError)
          ) {
            throw error
          }
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
  indexedKind: DocumentKind | undefined,
): Promise<ReadDocument> {
  const doc = await loadOrCreateDocument(deps, input.workspaceId, documentId)
  // A document created before kinds existed carries none on its own Loro
  // doc. Its index row, written at creation time, may still have one —
  // consult it before refusing. This is a read-only fallback: the kind
  // is never written back onto the doc or the row.
  const kind = readDocumentKind(doc) ?? indexedKind
  if (kind === undefined) {
    throw new DocumentKindUnknownError(documentId)
  }
  const threads = readAnnotations(doc)
  const proposals = readProposals(doc)
  const annotated = {
    ...(threads.length === 0 ? {} : { threads }),
    ...(proposals.length === 0 ? {} : { proposals }),
  }
  if (kind === 'markdown') {
    const { markdown, frontmatter } = await exportOkf(deps, {
      workspaceId: input.workspaceId,
      documentId,
    })
    return {
      documentId,
      kind,
      content: markdown,
      ...(frontmatter ? { frontmatter } : {}),
      ...annotated,
    }
  }
  const { json } = await exportJsonCanvas(deps, {
    workspaceId: input.workspaceId,
    documentId,
    ...(input.options ? { options: input.options } : {}),
  })
  return { documentId, kind, content: json, ...annotated }
}
