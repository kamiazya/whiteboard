import { documentIdSchema, parseScopedTag, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import { z } from 'zod'
import { ContentFactsCache } from '../references/content-facts-cache.js'
import type { TagBearer } from '../references/extract.js'
import type { ServerDeps } from '../server-deps.js'

export const documentTagsInputSchema = z.object({ workspaceId: workspaceIdSchema }).strict()
export type DocumentTagsInput = z.infer<typeof documentTagsInputSchema>

/**
 * One tag the workspace already uses, counted by what carries it
 * ([ADR-0040](../../../../docs/contributing/adr/0040-scoped-tags.md)
 * decision 5's in-use layer). `key` and `value` are present for a scoped tag
 * and absent for a plain one, so a reader can group by key without parsing.
 */
export const tagInUseSchema = z
  .object({
    tag: z.string().min(1),
    key: z.string().optional(),
    value: z.string().optional(),
    documents: z.number().int().nonnegative(),
    boards: z.number().int().nonnegative(),
    nodes: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
  })
  .strict()
export type TagInUse = z.infer<typeof tagInUseSchema>

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
    /** Every tag in use anywhere in the workspace, with counts — the vocabulary a picker offers. */
    inUse: z.array(tagInUseSchema),
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
export async function computeDocumentTags(
  deps: ServerDeps,
  input: DocumentTagsInput,
  cache: ContentFactsCache = new ContentFactsCache(),
): Promise<DocumentTagsOutput> {
  const entries = await deps.documentIndex.listDocuments({ workspaceId: input.workspaceId })
  const content = await cache.factsFor(deps, input.workspaceId, entries)
  const documents: DocumentTagsOutput['documents'] = []
  for (const entry of entries) {
    const tags = content
      .get(entry.documentId)
      ?.bearers.find((bearer) => bearer.what === 'document' || bearer.what === 'board')?.tags
    if (tags === undefined || tags.length === 0) continue
    documents.push({ documentId: entry.documentId, tags: [...tags] })
  }
  const bearers = entries.flatMap((entry) => content.get(entry.documentId)?.bearers ?? [])
  return { documents, inUse: tagsInUse(bearers) }
}

const COUNTED: Record<TagBearer['what'], keyof Omit<TagInUse, 'tag' | 'key' | 'value'>> = {
  document: 'documents',
  board: 'boards',
  node: 'nodes',
  edge: 'edges',
}

/** The vocabulary in use over a set of bearers, one row per tag, sorted by tag. */
function tagsInUse(bearers: readonly TagBearer[]): TagInUse[] {
  const rows = new Map<string, TagInUse>()
  for (const bearer of bearers) {
    for (const tag of new Set(bearer.tags)) {
      const scoped = parseScopedTag(tag)
      const row = rows.get(tag) ?? {
        tag,
        ...(scoped === undefined ? {} : { key: scoped.key, value: scoped.value }),
        documents: 0,
        boards: 0,
        nodes: 0,
        edges: 0,
      }
      rows.set(tag, { ...row, [COUNTED[bearer.what]]: row[COUNTED[bearer.what]] + 1 })
    }
  }
  // Code-unit order, not locale order: the same answer on every machine.
  return [...rows.values()].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
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
