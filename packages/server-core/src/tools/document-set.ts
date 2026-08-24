import { parseOkf } from '@kamiazya/whiteboard-codec'
import {
  readDocumentKind,
  readMarkdownBody,
  readSpatialCanvas,
  readTrustFacets,
  MARKDOWN_BODY_NODE_ID as TEXT_NODE_ID,
  writeCoreFacets,
  writeDocumentKind,
  writeFacets,
  writeMarkdownBody,
  writeTrustFacets,
} from '@kamiazya/whiteboard-loro-adapter'
import { documentIdSchema, okfActorSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
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
    /**
     * Who is producing this content, in OKF's actor convention (§7):
     * `<producer>/<version>` for an agent or tool, `human:<id>` for a
     * person, `process:<id>` for an automated process.
     *
     * Declared rather than inferred, because there is nothing here to infer
     * it from: `/mcp` builds a fresh server per request, so the `clientInfo`
     * from `initialize` never reaches a tool call, and local-daemon mode
     * authenticates every client on the machine with one shared token
     * (ADR-0016). OKF puts the obligation on the producer for the same
     * reason — trust tiers are advisory signals, not access control (§5.3).
     */
    actor: okfActorSchema.optional(),
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

/**
 * What `generated.by` says when the client did not identify itself. OKF
 * requires `by` inside `generated` (§5.2), so a stamp has to name someone —
 * and the honest answer is the server the write came through, not a guess at
 * which agent was driving. `process:<id>` is §7's form for exactly this.
 */
const UNATTRIBUTED_ACTOR = 'process:whiteboard-server'

export class OkfParseError extends Error {
  constructor(
    public readonly stage: string,
    message: string,
  ) {
    super(`OKF parse failed at ${stage}: ${message}`)
    this.name = 'OkfParseError'
  }
}

/**
 * Whether a `generated` the caller sent is foreign provenance to preserve,
 * rather than this server's own stamp echoed back by an edit.
 *
 * The distinction is needed because `wb_document_set` replaces the ENTIRE
 * content, so an agent changing one paragraph must read the document first —
 * and the read hands back the `generated` block this server wrote. Honouring
 * a declared `generated` unconditionally therefore freezes the stamp at the
 * first write, and every later edit by any actor keeps it. That is not a lost
 * signal but a false one, and it defeats the reason decision 2 gives for the
 * server owning the clock: `generated.at` is what a consumer uses to tell a
 * recent edit from a stale fact.
 *
 * Two conditions, and both are load-bearing:
 *
 * - The declared stamp must differ from the stored one. A stamp this server
 *   did not write is someone else's account of how the content was produced,
 *   and the import case decision 2 protects depends on it surviving.
 * - The body must have changed. A rewrite that changes nothing is not an
 *   origin event, so re-importing the same bundle twice does not lose its
 *   provenance to the second import.
 *
 * The BODY is the comparison, not the frontmatter: §5.2 says `generated`
 * records how the current CONTENT was produced, and for a markdown document
 * that is the body — a metadata-only edit must not claim the content was
 * regenerated.
 */
function keepsDeclaredGenerated(
  declared: { by: string; at: string } | undefined,
  stored: { by: string; at: string } | undefined,
  storedBody: string | undefined,
  nextBody: string,
): boolean {
  if (declared === undefined) return false
  const echoesOurStamp =
    stored !== undefined && stored.by === declared.by && stored.at === declared.at
  if (!echoesOurStamp) return true
  return storedBody === nextBody
}

export function createDocumentSetTool(deps: ServerDeps) {
  return {
    name: 'wb_document_set' as const,
    description:
      'Replace the entire content of an existing document from an OKF Markdown string. The document must already exist; core facets, extension facets and the body are all overwritten rather than merged. Pass `actor` to identify yourself — it is recorded as OKF `generated.by`, so a later reader can tell what wrote the document.',
    inputSchema: documentSetInputSchema,
    outputSchema: documentSetOutputSchema,
    execute: async (input: DocumentSetInput): Promise<DocumentSetOutput> => {
      await assertDocumentInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)

      const parsed = parseOkf(input.markdown)
      if (!parsed.ok) {
        throw new OkfParseError(parsed.error.stage, parsed.error.message)
      }

      const { frontmatter, body } = parsed.value
      const doc = await loadOrCreateDocument(deps, input.documentId)
      // Captured before anything below writes, because both are what the
      // document said a moment ago rather than what it is about to say.
      const storedTrust = readTrustFacets(doc)
      const storedBody = readMarkdownBody(doc)

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
              'Edit it through wb_canvas_edit, which records it as spatial and keeps them.',
          )
        }
        writeDocumentKind(doc, 'markdown')
      } else if (kind !== 'markdown') {
        throw new DocumentKindMismatchError(
          input.documentId,
          kind,
          'This writes OKF Markdown, which would replace its nodes and edges with a single text node. Edit a spatial document through wb_canvas_edit instead.',
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
      const { facets, title, generated, verified, ...coreFacets } = frontmatter
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

      // A `generated` the document already declares is the truth about how
      // that content was produced (§5.2) — importing it did not author it —
      // so it is honoured rather than restamped. Only content this write is
      // the origin of gets the server's clock (ADR-0016 decision 2).
      writeTrustFacets(doc, {
        generated: keepsDeclaredGenerated(generated, storedTrust?.generated, storedBody, body)
          ? (generated as NonNullable<typeof generated>)
          : {
              by: input.actor ?? UNATTRIBUTED_ACTOR,
              at: new Date().toISOString(),
            },
        ...(verified === undefined ? {} : { verified }),
      })

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
