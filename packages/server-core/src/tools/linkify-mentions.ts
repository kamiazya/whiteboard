import { createUniqueNameResolver } from '@kamiazya/whiteboard-codec'
import {
  MARKDOWN_BODY_KEY,
  readDocumentKind,
  readSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  documentIdSchema,
  spatialCanvasSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { unlinkedNameSpans } from '../references/reference-aggregate.js'
import type { ServerDeps } from '../server-deps.js'
import { WorkspaceDocumentNotFoundError } from './document-crud.errors.js'
import { loadDocument, saveDocumentBodySnapshot, saveDocumentSnapshot } from './document-io.js'

export const linkifyMentionsInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    /** The SOURCE — the document whose prose gets rewritten. */
    documentId: documentIdSchema,
    /** The document the mentions name. */
    targetDocumentId: documentIdSchema,
  })
  .strict()
export type LinkifyMentionsInput = z.infer<typeof linkifyMentionsInputSchema>

export const linkifyMentionsOutputSchema = z
  .object({ linked: z.number().int().nonnegative() })
  .strict()
export type LinkifyMentionsOutput = z.infer<typeof linkifyMentionsOutputSchema>

/** The target carries no display name, so there is no prose to find. */
export class NamelessLinkifyTargetError extends Error {
  constructor(readonly targetDocumentId: string) {
    super(
      `Document ${targetDocumentId} has no display name — nothing names it in prose, so there is nothing to linkify.`,
    )
    this.name = 'NamelessLinkifyTargetError'
  }
}

function rewrite(text: string, name: string, markup: string): { text: string; count: number } {
  const spans = unlinkedNameSpans(text, name)
  let out = text
  // Reverse order so earlier spans' offsets stay valid while later ones are
  // spliced.
  for (const span of [...spans].reverse()) {
    out = out.slice(0, span.index) + markup + out.slice(span.index + span.length)
  }
  return { text: out, count: spans.length }
}

/**
 * Convert a source document's unlinked mentions of `targetDocumentId` into
 * `[[...]]` references, as ONE server-side load-modify-save — the panel's
 * Link-it action. Client-side offset patching of another live CRDT document
 * is exactly the stale-offset class the completion once shipped, which is
 * why this lives here.
 *
 * Markdown bodies are edited by targeted Loro text splices (reverse order,
 * one commit), so a concurrent edit elsewhere in the body merges instead of
 * being clobbered by a whole-body replace. Canvas TEXT NODES go through the
 * schema-validated canvas save; labels are mention-DETECTED but never
 * rewritten — a `[[link]]` in a label renders as literal brackets.
 */
export async function linkifyMentions(
  deps: ServerDeps,
  input: LinkifyMentionsInput,
): Promise<LinkifyMentionsOutput> {
  const entries = await deps.documentIndex.listDocuments({ workspaceId: input.workspaceId })
  const byId = new Map(entries.map((entry) => [entry.documentId, entry]))
  const source = byId.get(input.documentId)
  if (source === undefined) {
    throw new WorkspaceDocumentNotFoundError(input.workspaceId, input.documentId)
  }
  const target = byId.get(input.targetDocumentId)
  if (target === undefined) {
    throw new WorkspaceDocumentNotFoundError(input.workspaceId, input.targetDocumentId)
  }
  if (target.name === undefined) throw new NamelessLinkifyTargetError(input.targetDocumentId)
  const name = target.name

  // The reader's rule decides the spelling: the readable [[Name]] only when
  // resolution would land on the target, the explicit [[<id>|Name]] form
  // otherwise — the same trade the link picker makes.
  const resolve = createUniqueNameResolver(
    entries.flatMap((entry) => [
      { id: entry.documentId, name: entry.path },
      ...(entry.name === undefined ? [] : [{ id: entry.documentId, name: entry.name }]),
    ]),
  )
  const markup =
    resolve(name) === input.targetDocumentId
      ? `[[${name}]]`
      : `[[${input.targetDocumentId}|${name}]]`

  const { doc, canvas } = await loadDocument(deps, input.workspaceId, input.documentId)
  const kind = source.kind ?? readDocumentKind(doc)

  if (kind === 'markdown') {
    const text = doc.getText(MARKDOWN_BODY_KEY)
    const spans = unlinkedNameSpans(text.toString(), name)
    for (const span of [...spans].reverse()) {
      text.delete(span.index, span.length)
      text.insert(span.index, markup)
    }
    if (spans.length === 0) return { linked: 0 }
    doc.commit()
    await saveDocumentSnapshot(deps, input.workspaceId, input.documentId, doc)
    return { linked: spans.length }
  }

  let linked = 0
  const nodes = readSpatialCanvas(doc).nodes.map((node) => {
    if (node.type !== 'text') return node
    const result = rewrite(node.text, name, markup)
    linked += result.count
    return result.count === 0 ? node : { ...node, text: result.text }
  })
  if (linked === 0) return { linked: 0 }
  const candidate = spatialCanvasSchema.parse({ nodes, edges: canvas.edges })
  await saveDocumentBodySnapshot(deps, input.workspaceId, input.documentId, doc, candidate)
  return { linked }
}
