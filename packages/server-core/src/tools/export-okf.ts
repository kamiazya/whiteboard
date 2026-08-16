import type { OkfMarkdownFrontmatter } from '@kamiazya/whiteboard-canvas-codec'
import { okfMarkdownFrontmatterSchema, serializeOkf } from '@kamiazya/whiteboard-canvas-codec'
import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { readCoreFacets, readFacets, readMarkdownBody } from '@kamiazya/whiteboard-canvas-workspace'
import { z } from 'zod'
import { loadSpatialCanvas } from '../render/load-spatial-canvas.js'
import type { ServerDeps } from '../server-deps.js'

/**
 * OKF-Markdown is a single-document format (frontmatter + body); a spatial
 * canvas can have many independently-positioned text nodes. This
 * targets only the FIRST text node found (or an empty body when none
 * exists) — a real "canvas -> OKF" mapping for a full multi-node spatial
 * canvas is deferred to a future slice once the OKF-vs-spatial duality is
 * resolved in canvas-workspace.
 *
 * `DocumentStore.loadSnapshot`'s `DocRef` carries no `workspaceId` — this
 * field is accepted for API symmetry with the workspace-scoped tools and as a
 * future authorization-scoping hook, not passed to the store.
 */
export const exportOkfInputSchema = z
  .object({ workspaceId: workspaceIdSchema, documentId: documentIdSchema })
  .strict()
export type ExportOkfInput = z.infer<typeof exportOkfInputSchema>

export const exportOkfOutputSchema = z
  .object({ markdown: z.string(), frontmatter: okfMarkdownFrontmatterSchema })
  .strict()
export type ExportOkfOutput = z.infer<typeof exportOkfOutputSchema>

/**
 * `coreFacetsSchema.type` is required, but a spatial (JSON Canvas) doc has
 * no notion of an OKF core-facet `type` of its own — the two formats are
 * deliberately distinct document shapes (package-canvas-codec.md). `canvas`
 * is the fallback value used ONLY when no core meta was ever persisted for
 * this doc (every canvas created before this bridge existed, or a
 * spatial-only canvas that never went through `wb_document_set`). Once a
 * doc has stored core meta (via `writeCoreFacets`), that stored `type`
 * (and `title`/`tags`/`view`/`facetsRaw`) is echoed back instead — this is
 * what makes the `wb_document_set` -> OKF export round-trip
 * faithful.
 */
const OKF_EXPORT_PLACEHOLDER_TYPE = 'canvas'

/**
 * Serialise a document as OKF Markdown (YAML frontmatter plus body).
 *
 * Not an MCP tool: `wb_document_get` chooses this projection for a markdown
 * document, and the `/okf` route reaches it directly for the workspace tree.
 */
export async function exportOkf(deps: ServerDeps, input: ExportOkfInput): Promise<ExportOkfOutput> {
  const { doc } = await loadSpatialCanvas(deps, input.documentId)
  const coreFacets = readCoreFacets(doc)
  // The name is the workspace's (ADR-0009 decision 2), so it is read from
  // there rather than from stored content — the frontmatter `title` this
  // emits is a projection, and an unnamed document emits none rather than
  // being handed its path as a title.
  const entry = await deps.documentIndex.resolveDocumentById({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
  })
  const facets = readFacets(doc)
  const body = readMarkdownBody(doc)
  const frontmatter: OkfMarkdownFrontmatter = {
    ...(coreFacets ?? { type: OKF_EXPORT_PLACEHOLDER_TYPE }),
    ...(entry?.name === undefined ? {} : { title: entry.name }),
    facets,
  }
  const markdown = serializeOkf({ frontmatter, body })
  return { markdown, frontmatter }
}
