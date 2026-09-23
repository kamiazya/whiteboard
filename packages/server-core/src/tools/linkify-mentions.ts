import { readDocumentKind } from '@kamiazya/whiteboard-loro-adapter'
import { linkifyMentionsIn } from '@kamiazya/whiteboard-reference-graph'
import type { ServerDeps } from '../server-deps.js'
import { WorkspaceDocumentNotFoundError } from './document-crud.errors.js'
import { loadDocument, saveDocumentSnapshot } from './document-io.js'

import type { LinkifyMentionsInput, LinkifyMentionsOutput } from './linkify-mentions.schemas.js'

export {
  type LinkifyMentionsInput,
  type LinkifyMentionsOutput,
  linkifyMentionsInputSchema,
  linkifyMentionsOutputSchema,
} from './linkify-mentions.schemas.js'

/** The target carries no display name, so there is no prose to find. */
export class NamelessLinkifyTargetError extends Error {
  constructor(readonly targetDocumentId: string) {
    super(
      `Document ${targetDocumentId} has no display name — nothing names it in prose, so there is nothing to linkify.`,
    )
    this.name = 'NamelessLinkifyTargetError'
  }
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

  const { doc } = await loadDocument(deps, input.workspaceId, input.documentId)
  const linked = linkifyMentionsIn(doc, source.kind ?? readDocumentKind(doc) ?? 'spatial', {
    documentId: input.targetDocumentId,
    path: target.path,
    name: target.name,
  })
  if (linked > 0) await saveDocumentSnapshot(deps, input.workspaceId, input.documentId, doc)
  return { linked }
}
