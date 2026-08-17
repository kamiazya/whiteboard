import { parseOkf } from '@kamiazya/whiteboard-codec'
import {
  readDocumentKind,
  readSpatialCanvas,
  MARKDOWN_BODY_NODE_ID as TEXT_NODE_ID,
  writeCoreFacets,
  writeDocumentKind,
  writeFacets,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { assertCanvasInWorkspace } from './assert-canvas-in-workspace.js'
import { loadOrCreateDocument, saveDocumentSnapshot } from './document-io.js'
import { DocumentContentLossError, DocumentKindMismatchError } from './errors.js'

/**
 * Whether a canvas is one this tool could itself have written, and so holds
 * nothing a markdown write would destroy.
 *
 * A markdown document written today has an empty canvas — the body is a
 * CRDT text container. One written by the older writer stored the body as a
 * single `okf-body` text node, which made it ALSO a valid one-node spatial
 * canvas, so "has any node" cannot tell such a document from a diagram.
 * Accepting that legacy shape as well keeps documents that predate both the
 * container and kinds editable, without letting a real diagram through.
 */
function isMarkdownShaped(canvas: { nodes: readonly { id: string }[]; edges: readonly unknown[] }) {
  if (canvas.edges.length > 0) return false
  return (
    canvas.nodes.length === 0 || (canvas.nodes.length === 1 && canvas.nodes[0]?.id === TEXT_NODE_ID)
  )
}

export const documentSetInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
    markdown: z.string(),
  })
  .strict()
export type DocumentSetInput = z.infer<typeof documentSetInputSchema>

export const documentSetOutputSchema = z
  .object({
    documentId: documentIdSchema,
    imported: z.literal(true),
  })
  .strict()
export type DocumentSetOutput = z.infer<typeof documentSetOutputSchema>

export class OkfParseError extends Error {
  constructor(
    public readonly stage: string,
    message: string,
  ) {
    super(`OKF parse failed at ${stage}: ${message}`)
    this.name = 'OkfParseError'
  }
}

export function createDocumentSetTool(deps: ServerDeps) {
  return {
    name: 'wb_document_set' as const,
    description:
      'Replace the entire content of an existing document from an OKF Markdown string. The document must already exist; core facets, extension facets and the body are all overwritten rather than merged.',
    inputSchema: documentSetInputSchema,
    outputSchema: documentSetOutputSchema,
    execute: async (input: DocumentSetInput): Promise<DocumentSetOutput> => {
      await assertCanvasInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)

      const parsed = parseOkf(input.markdown)
      if (!parsed.ok) {
        throw new OkfParseError(parsed.error.stage, parsed.error.message)
      }

      const { frontmatter, body } = parsed.value
      const doc = await loadOrCreateDocument(deps, input.documentId)

      // The write below replaces the whole spatial canvas, so on a spatial
      // document it is a destruction rather than an edit. A document with no
      // kind predates them: the write is the only thing that can give it one,
      // and refusing would leave it with no way back (ADR-0009 decision 4) —
      // but only a document already in markdown's own shape has nothing to
      // lose by being declared markdown. One holding a canvas gets its way
      // back from the spatial side, which declares a kind without discarding
      // anything.
      const kind = readDocumentKind(doc)
      if (kind === undefined) {
        const existing = readSpatialCanvas(doc)
        if (!isMarkdownShaped(existing)) {
          throw new DocumentContentLossError(
            input.documentId,
            `It holds ${existing.nodes.length} node(s) and ${existing.edges.length} edge(s), which this write would replace with a single text node. ` +
              'Edit it through wb_node_add / wb_node_patch / wb_edge_patch, which records it as spatial and keeps them.',
          )
        }
        writeDocumentKind(doc, 'markdown')
      } else if (kind !== 'markdown') {
        throw new DocumentKindMismatchError(
          input.documentId,
          kind,
          'This writes OKF Markdown, which would replace its nodes and edges with a single text node. Edit a spatial document through wb_node_add / wb_node_patch / wb_edge_patch instead.',
        )
      }

      // OKF is an export format, not the storage model: the Loro side keeps
      // its own OKF-compatible document, and the workspace owns the name. So
      // parsing an OKF projects it INTO that model exactly as serialising
      // projects back out, and `title` lands on the workspace rather than
      // becoming a second stored copy (ADR-0009 decision 2).
      //
      // Absent is not cleared: an OKF with no `title` says nothing about the
      // name, so omitting it must not erase one.
      const { facets, title, ...coreFacets } = frontmatter
      if (title !== undefined) {
        // A blank title is not a name, and the two are deliberately one
        // state — so writing one clears the name rather than storing '' for
        // a reader to fall back from a second time.
        const trimmed = title.trim()
        await deps.documentIndex.setDocumentName({
          workspaceId: input.workspaceId,
          documentId: input.documentId,
          ...(trimmed === '' ? {} : { name: trimmed }),
        })
      }
      writeCoreFacets(doc, coreFacets)
      if (facets) {
        writeFacets(doc, facets)
      }

      // The body goes in the CRDT text container, and this clears the
      // spatial canvas with it (see writeMarkdownBody). Older documents
      // stored it as an `okf-body` TEXT NODE, which made every markdown
      // document also parse as a valid one-node canvas — the ambiguity that
      // forces every reference resolver to ask the document its kind before
      // it can tell prose from a diagram. Reads handle both shapes, so
      // stored documents need no migration; they converge as they are
      // rewritten.
      writeMarkdownBody(doc, body)

      await saveDocumentSnapshot(deps, input.documentId, doc)

      return { documentId: input.documentId, imported: true }
    },
  }
}
