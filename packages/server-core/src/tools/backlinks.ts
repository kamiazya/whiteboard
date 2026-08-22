import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { ContentFactsCache } from '../references/content-facts-cache.js'
import {
  backlinkEntrySchema,
  mentionsOfIn,
  ReferenceAggregate,
} from '../references/reference-aggregate.js'
import type { ServerDeps } from '../server-deps.js'
import { WorkspaceDocumentNotFoundError } from './document-crud.errors.js'

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
 * context excerpt per reference, plus the sources that NAME it without
 * linking. Read-only.
 *
 * Content facts come through the stamp-validated ContentFactsCache: only
 * documents whose frontier moved since the last request are reloaded. The
 * per-request ReferenceAggregate build over cached facts is in-memory map
 * work and stays; the aggregate remains the one query engine an event feed
 * would also fill.
 */
export async function computeBacklinks(
  deps: ServerDeps,
  input: BacklinksInput,
  cache: ContentFactsCache = new ContentFactsCache(),
): Promise<BacklinksOutput> {
  const entries = await deps.documentIndex.listDocuments({ workspaceId: input.workspaceId })
  if (!entries.some((entry) => entry.documentId === input.documentId)) {
    throw new WorkspaceDocumentNotFoundError(input.workspaceId, input.documentId)
  }

  const content = await cache.factsFor(deps, entries)
  const aggregate = new ReferenceAggregate()
  for (const entry of entries) {
    const facts = content.get(entry.documentId)
    aggregate.upsert(entry.documentId, 0, {
      path: entry.path,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(entry.kind === undefined ? {} : { kind: entry.kind }),
      refs: [...(facts?.refs ?? [])],
      texts: [...(facts?.texts ?? [])],
    })
  }
  const alive = aggregate.entries()
  const name = alive.get(input.documentId)?.name
  return {
    backlinks: aggregate.backlinksOf(input.documentId),
    unlinkedMentions:
      name === undefined ? [] : mentionsOfIn({ documentId: input.documentId, name }, alive),
  }
}
