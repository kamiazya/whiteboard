/**
 * The input and output contracts of `wb_facet_set`, and nothing else: the
 * schemas apart from the operation, as this directory's other tools keep
 * them.
 */
import {
  documentIdSchema,
  extensionFacetsSchema,
  nodeIdSchema,
  TAG_COUNT_LIMIT_PHRASE,
  TAGS_PER_ELEMENT_MAX,
  tagListWriteSchema,
  tagWriteSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'

/**
 * A ceiling on one request. Facet payloads are small, so this is not about
 * size; it is about a batch big enough that a caller cannot read what it
 * just did.
 */
const MAX_DOCUMENTS = 50

/**
 * Tags are OKF core frontmatter, and "tag this note" is the thing a caller
 * is usually doing when it reaches for this tool — so the shape is the
 * errand's (add these, drop those, keep the rest), not the storage's (the
 * whole list, replaced). The whole-list shape would make ONE payload over
 * many documents clobber each document's own tags, which is exactly the
 * batch this tool exists for.
 */
const tagsChangeSchema = z
  .object({
    // The scoped-tag grammar (ADR-0040 decision 1) is checked HERE, where a
    // tag is written, and only on `add`: a removal names what is stored, and
    // what is stored may have been written by another tool.
    add: tagListWriteSchema
      .optional()
      .describe('Tags to add; one already present is left where it is.'),
    remove: z
      .array(z.string().min(1))
      .max(TAGS_PER_ELEMENT_MAX, `more tags to remove than ${TAG_COUNT_LIMIT_PHRASE}`)
      .optional()
      .describe('Tags to drop, by name.'),
    /**
     * Vocabulary maintenance (ADR-0040 decision 5): a typo recovered, or two
     * spellings merged, across everything the named documents hold. Priced
     * against a tool of its own before landing here — see the ADR.
     */
    rename: z
      .array(
        z
          .object({
            from: z.string().min(1).describe('The tag as it is spelled now.'),
            to: tagWriteSchema.describe('What to call it; an existing tag merges.'),
          })
          .strict(),
      )
      .max(TAGS_PER_ELEMENT_MAX, `more tags to rename than ${TAG_COUNT_LIMIT_PHRASE}`)
      .optional()
      .describe(
        'Rename tags throughout the documents named — their own tags and every node and edge — or, with nodeId / edgeId, on that object alone.',
      ),
  })
  .strict()
  // `tags: {}` would pass every later guard and save an unchanged tag
  // list as a new snapshot — the silent no-op the payload guard exists
  // to refuse, arriving one level down.
  .refine(
    (change) =>
      (change.add?.length ?? 0) + (change.remove?.length ?? 0) + (change.rename?.length ?? 0) > 0,
    { message: 'name at least one tag to add, remove or rename' },
  )

/**
 * `extensionFacetsSchema` already enforces the `{namespace}.{name}/v{n}` key
 * pattern (model's `EXTENSION_FACET_KEY_PATTERN`), so a caller can
 * never use this tool to set a core facet (`type`/`title`/`tags`/`view`) or
 * the raw `facets` root key itself — those don't match the pattern and are
 * rejected at parse time rather than needing a separate namespace guard.
 */
export const facetSetInputSchema = z
  .object({
    workspaceId: workspaceIdSchema.describe('The workspace the documents belong to.'),
    documentIds: z
      .array(documentIdSchema)
      .min(1)
      .max(MAX_DOCUMENTS)
      .describe('The documents to write, all with the same payload.'),
    /**
     * Present: the write targets this NODE of a spatial document (facets
     * land in the node's x-whiteboard facets bucket). Absent: the write
     * targets the documents themselves (markdown only).
     */
    nodeId: nodeIdSchema
      .optional()
      .describe(
        'Write to this node of a spatial document instead of to the document itself. Takes exactly one documentId.',
      ),
    /**
     * Present: the write targets this EDGE of a spatial document (facets
     * land in the edge's own x-whiteboard facets bucket, ADR-0013 decision
     * 5's edge slot). Mutually exclusive with `nodeId` and `target`, for the
     * reason those two are exclusive with each other: a write lands on one
     * object, and two ways of naming it are two chances to disagree.
     */
    edgeId: nodeIdSchema
      .optional()
      .describe(
        'Write to this edge of a spatial document instead of to the document itself. Takes exactly one documentId.',
      ),
    tags: tagsChangeSchema
      .optional()
      .describe(
        'Add and remove tags by name on the documents, on a board, or (with nodeId / edgeId) on one node or edge; every other tag stays. A scoped tag is key:value in lowercase identifiers, e.g. health:failing, and one key may carry several values.',
      ),
    /**
     * Where a write with neither `nodeId` nor `edgeId` lands: the documents
     * themselves (markdown frontmatter; the default), or the CANVAS envelope
     * of a spatial document (`x-whiteboard.facets` — ADR-0013 decision 5's
     * canvas slot, where `visual.theme/v0` and a board-wide `visual.edges/v0`
     * live). Two answers rather than four, because `nodeId` and `edgeId`
     * already say which object, and saying it twice is how the two disagree.
     */
    target: z.enum(['document', 'canvas']).optional(),
    /**
     * ONE payload for every document named, not one per document. "Tag
     * these as reviewed" is the thing a caller is actually doing; two
     * different payloads are two different writes and cost a call each.
     *
     * A null value DELETES that facet; anything else sets it. Deletion is
     * an input-only tombstone — stored buckets never hold null.
     */
    facets: extensionFacetsSchema
      .optional()
      .describe(
        'Extension facets to set, keyed `{namespace}.{name}/v{n}` (wb_facet_list says which are registered). Merged by key: an omitted key keeps its value, null deletes it. Not for tags — those are `tags`.',
      ),
  })
  .strict()
export type FacetSetInput = z.infer<typeof facetSetInputSchema>

export const facetSetOutputSchema = z
  .object({
    updated: z
      .array(
        z
          .object({
            documentId: documentIdSchema,
            facets: extensionFacetsSchema.describe(
              'The extension facets now on the document or node.',
            ),
            tags: z
              .array(z.string())
              .optional()
              .describe(
                'The tags on the document, board, node or edge after the write, when `tags` was given.',
              ),
          })
          .strict(),
      )
      .describe('One entry per document, in the order asked for.'),
  })
  .strict()
export type FacetSetOutput = z.infer<typeof facetSetOutputSchema>
