import type { OkfMarkdownFrontmatter } from '@kamiazya/whiteboard-codec'
import { serializeOkf } from '@kamiazya/whiteboard-codec'
import {
  readCoreFacets,
  readDocumentKind,
  readFacets,
  readMarkdownBody,
  readTrustFacets,
} from '@kamiazya/whiteboard-loro-adapter'
import type { ServerDeps } from '../server-deps.js'
import { BARE_BODY_TYPE } from './document-crud.js'
import { loadDocument } from './document-io.js'
import { DocumentKindMismatchError, DocumentSerializeError } from './errors.js'

/**
 * OKF-Markdown is a single-document format (frontmatter + body), which is what
 * a markdown document is. A spatial canvas has no body — its nodes are
 * independently positioned — so it is refused rather than projected onto one
 * of its text nodes: there is no "read this document as OKF" for a JSON Canvas
 * document (`wb_document_get` follows the document's kind instead).
 *
 * `DocumentStore.loadSnapshot`'s `DocRef` carries no `workspaceId` — this
 * field is accepted for API symmetry with the workspace-scoped tools and as a
 * future authorization-scoping hook, not passed to the store.
 */
import type { ExportOkfInput, ExportOkfOutput } from './export-okf.schemas.js'

export {
  type ExportOkfInput,
  type ExportOkfOutput,
  exportOkfInputSchema,
  exportOkfOutputSchema,
} from './export-okf.schemas.js'

/**
 * Serialise a document as OKF Markdown (YAML frontmatter plus body).
 *
 * Not an MCP tool: `wb_document_get` chooses this projection for a markdown
 * document, and the `/okf` route reaches it directly for the workspace tree.
 */
export async function exportOkf(deps: ServerDeps, input: ExportOkfInput): Promise<ExportOkfOutput> {
  const { doc } = await loadDocument(deps, input.workspaceId, input.documentId)
  const coreFacets = readCoreFacets(doc)
  // The name is the workspace's (ADR-0009 decision 2), so it is read from
  // there rather than from stored content — the frontmatter `title` this
  // emits is a projection, and an unnamed document emits none rather than
  // being handed its path as a title.
  const entry = await deps.documentIndex.resolveDocumentById({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
  })
  // A document that predates kinds carries none on its own doc; its index row
  // may. One with neither is read as the markdown it has always been taken for.
  const kind = readDocumentKind(doc) ?? entry?.kind
  if (kind !== undefined && kind !== 'markdown') {
    throw new DocumentKindMismatchError(
      input.documentId,
      kind,
      'It has no body to export as OKF Markdown. Read it with wb_document_get, which answers JSON Canvas for a spatial document.',
    )
  }
  const facets = readFacets(doc)
  const body = readMarkdownBody(doc)
  // The trust family lives in its own bucket (ADR-0016 decision 4) and is
  // projected back to the frontmatter ROOT, where OKF puts it — the same
  // projection `title` gets from the workspace name.
  const trust = readTrustFacets(doc)
  const frontmatter: OkfMarkdownFrontmatter = {
    // `coreFacetsSchema.type` is required. Every markdown document is born
    // with one, so this only answers for a row that predates that, and says
    // what a body with no declared type is.
    ...(coreFacets ?? { type: BARE_BODY_TYPE }),
    ...(entry?.name === undefined ? {} : { title: entry.name }),
    ...(trust ?? {}),
    facets,
  }
  // Pure, so a throw here is about THIS document's content and nothing else —
  // the caller can report it per document instead of failing the batch.
  let markdown: string
  try {
    markdown = serializeOkf({ frontmatter, body })
  } catch (error) {
    throw new DocumentSerializeError(input.documentId, 'OKF Markdown', error)
  }
  return { markdown, body, frontmatter }
}
