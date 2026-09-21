/**
 * wb_document_tags's input and output contracts, and nothing else.
 *
 * Schemas only, so `../contracts.ts` can publish them to a BROWSER without
 * the tool's own graph coming with them. See that file for why the split
 * exists rather than being a matter of taste.
 */
import { documentIdSchema, tagInUseSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { tagLibrarySchema } from '@kamiazya/whiteboard-plugin-visual'
import { z } from 'zod'

export const documentTagsInputSchema = z.object({ workspaceId: workspaceIdSchema }).strict()
export type DocumentTagsInput = z.infer<typeof documentTagsInputSchema>

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
