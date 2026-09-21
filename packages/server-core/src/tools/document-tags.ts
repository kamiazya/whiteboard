import {
  documentIdSchema,
  type TagInUse,
  tagInUseSchema,
  tagsInUse,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { tagLibrarySchema } from '@kamiazya/whiteboard-plugin-visual'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import { z } from 'zod'
import { ContentFactsCache } from '../references/content-facts-cache.js'
import type { ServerDeps } from '../server-deps.js'
import { workspaceTagLibrary } from './tag-library.js'

export const documentTagsInputSchema = z.object({ workspaceId: workspaceIdSchema }).strict()
export type DocumentTagsInput = z.infer<typeof documentTagsInputSchema>

// The row shape and the counting are `@kamiazya/whiteboard-model`'s
// (ADR-0040 decision 5's in-use layer): a DECISION both keepers must take
// identically, where only gathering the bearers is each keeper's own.
// Re-exported because this module is where the tool's output schema is
// assembled and its readers import the row from here.
export { type TagInUse, tagInUseSchema }

export const documentTagsOutputSchema = z
  .object({
    /**
     * Only documents that CARRY tags of their own: a note's OKF core tags,
     * or a board's (ADR-0040 decision 2). Listing tagless ones would make
     * every client re-filter the same emptiness. What a board's nodes and
     * edges carry is not the document's and is counted in `inUse` instead.
     */
    documents: z.array(
      z.object({ documentId: documentIdSchema, tags: z.array(z.string()).min(1) }).strict(),
    ),
    /**
     * What a board's NODES and EDGES carry, per board, deduplicated — the
     * filter's other half (ADR-0040 decision 3): a board is found by a tag
     * one of its boxes carries, so a client filtering on a chip the
     * vocabulary counted from boxes reads this beside `documents`. Only
     * boards with something carried inside; a board's own tags are in
     * `documents`, and a note has nothing inside to carry one.
     */
    contents: z.array(
      z.object({ documentId: documentIdSchema, tags: z.array(z.string()).min(1) }).strict(),
    ),
    /** Every tag in use anywhere in the workspace, with counts — the vocabulary a picker offers. */
    inUse: z.array(tagInUseSchema),
    /**
     * What the workspace DECLARES (ADR-0040 decision 5's other layer): the
     * document at `tags`, read as a value — `{}` when there is none, so a
     * client never has to tell "declares nothing" from "did not answer".
     * Beside `inUse` because a picker wants both in one round trip, and the
     * listing that finds the library is the one already taken here.
     */
    library: tagLibrarySchema,
  })
  .strict()
export type DocumentTagsOutput = z.infer<typeof documentTagsOutputSchema>

/**
 * The workspace's tag projection, for the document browser's search and
 * filter chips.
 *
 * Served from the stamp-validated ContentFactsCache: only documents whose
 * frontier moved are reloaded (ADR-0014's incremental mode, cache form).
 */
/**
 * A document's OWN tags and the ones its contents carry, which are two
 * different answers about the same document.
 *
 * Own is the document's frontmatter or its board's envelope — one bearer,
 * because a document has one of those. Carried is the union over its nodes and
 * edges, deduplicated, because a tag on three boxes is one tag the document
 * contains. Any other bearer kind belongs to neither.
 */
function splitBearerTags(bearers: readonly { what: string; tags: readonly string[] }[]): {
  own: string[]
  carried: string[]
} {
  const own = bearers.find((bearer) => bearer.what === 'document' || bearer.what === 'board')?.tags
  const carried = new Set<string>()
  for (const bearer of bearers) {
    if (bearer.what !== 'node' && bearer.what !== 'edge') continue
    for (const tag of bearer.tags) carried.add(tag)
  }
  return { own: own === undefined ? [] : [...own], carried: [...carried] }
}

export async function computeDocumentTags(
  deps: ServerDeps,
  input: DocumentTagsInput,
  cache: ContentFactsCache = new ContentFactsCache(),
): Promise<DocumentTagsOutput> {
  const entries = await deps.documentIndex.listDocuments({ workspaceId: input.workspaceId })
  const content = await cache.factsFor(deps, input.workspaceId, entries)
  const documents: DocumentTagsOutput['documents'] = []
  const contents: DocumentTagsOutput['contents'] = []
  for (const entry of entries) {
    const { own, carried } = splitBearerTags(content.get(entry.documentId)?.bearers ?? [])
    if (own.length > 0) documents.push({ documentId: entry.documentId, tags: own })
    if (carried.length > 0) contents.push({ documentId: entry.documentId, tags: carried })
  }
  const bearers = entries.flatMap((entry) => content.get(entry.documentId)?.bearers ?? [])
  const library = await workspaceTagLibrary(deps, input.workspaceId, 'refuse', entries)
  return { documents, contents, inUse: tagsInUse(bearers), library }
}

/** The same listing from the store, over a listing the caller already holds. */
export async function computeTagsInUse(
  deps: ServerDeps,
  workspaceId: string,
  entries: readonly DocumentEntry[],
  cache: ContentFactsCache = new ContentFactsCache(),
): Promise<TagInUse[]> {
  const content = await cache.factsFor(deps, workspaceId, entries)
  return tagsInUse(entries.flatMap((entry) => content.get(entry.documentId)?.bearers ?? []))
}
