import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { extractReferenceFacts } from '../references/extract.js'
import {
  backlinkEntrySchema,
  mentionsOfIn,
  ReferenceAggregate,
} from '../references/reference-aggregate.js'
import type { ServerDeps } from '../server-deps.js'
import { WorkspaceDocumentNotFoundError } from './document-crud.errors.js'
import { loadDocument } from './document-io.js'

export const backlinksInputSchema = z
  .object({ workspaceId: workspaceIdSchema, documentId: documentIdSchema })
  .strict()
export type BacklinksInput = z.infer<typeof backlinksInputSchema>

export const backlinksOutputSchema = z
  .object({
    backlinks: z.array(backlinkEntrySchema),
    /** Sources naming this document in prose without a resolving link. */
    unlinkedMentions: z.array(backlinkEntrySchema),
  })
  .strict()
export type BacklinksOutput = z.infer<typeof backlinksOutputSchema>

/**
 * Every document in the workspace that references `documentId`, with one
 * context excerpt per reference. Read-only.
 *
 * Runs the ReferenceAggregate in its non-incremental mode: build from a
 * full scan, query once, discard. Same class as the future event-fed
 * incremental index, so the two modes cannot drift.
 *
 * ponytail: O(N) document loads per request. Measured fine at dev-data
 * scale; when a measured workspace makes this slow, keep ONE aggregate
 * alive and feed it upsert/remove events from the save paths.
 */
export async function computeBacklinks(
  deps: ServerDeps,
  input: BacklinksInput,
): Promise<BacklinksOutput> {
  const entries = await deps.documentIndex.listDocuments({ workspaceId: input.workspaceId })
  if (!entries.some((entry) => entry.documentId === input.documentId)) {
    throw new WorkspaceDocumentNotFoundError(input.workspaceId, input.documentId)
  }

  const aggregate = new ReferenceAggregate()
  for (const entry of entries) {
    let doc: Awaited<ReturnType<typeof loadDocument>>['doc']
    try {
      doc = (await loadDocument(deps, entry.documentId)).doc
    } catch {
      // A document with no snapshot yet holds no references — but it still
      // EXISTS: its path and name must take part in resolution (a name
      // collision with it breaks other links), so it enters with no refs.
      aggregate.upsert(entry.documentId, 0, {
        path: entry.path,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        ...(entry.kind === undefined ? {} : { kind: entry.kind }),
        refs: [],
        texts: [],
      })
      continue
    }
    aggregate.upsert(entry.documentId, 0, extractReferenceFacts(entry, doc))
  }
  const alive = aggregate.entries()
  const name = alive.get(input.documentId)?.name
  return {
    backlinks: aggregate.backlinksOf(input.documentId),
    unlinkedMentions:
      name === undefined ? [] : mentionsOfIn({ documentId: input.documentId, name }, alive),
  }
}
