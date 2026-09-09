import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { versionEntryForAgent, versionEntryForAgentSchema } from '../versions/version-entry.js'
import { resolveDocumentInWorkspace } from './assert-document-in-workspace.js'
import { loadOrCreateDocument } from './document-io.js'

/**
 * A ceiling on one request. Unlike `wb_document_get`'s, this one is not
 * about payload size — a version row is small — but about a batch big
 * enough that a caller cannot read what it just did.
 */
const MAX_DOCUMENTS = 50

export const versionSaveInputSchema = z
  .object({
    workspaceId: workspaceIdSchema.describe('Workspace that holds the documents.'),
    documentIds: z
      .array(documentIdSchema)
      .min(1)
      .max(MAX_DOCUMENTS)
      .describe('Document IDs (ULIDs) to save a version of.'),
    /**
     * ONE label for the whole batch, not one per document. A shared label is
     * what makes several documents one checkpoint — "before the risky edit"
     * across a set is the thing a caller is actually recording. Different
     * labels are different saves, and cost a call each; that is the honest
     * price of asking for something else.
     */
    label: z.string().min(1).max(200).describe('Human-readable label for this checkpoint.'),
  })
  .strict()
export type VersionSaveInput = z.infer<typeof versionSaveInputSchema>

export const versionSaveOutputSchema = z
  .object({
    /**
     * One entry per document, in the order asked for. The row is as the
     * History panel lists it; `version.id` is what wb_version_restore takes.
     */
    saved: z
      .array(
        z.object({ documentId: documentIdSchema, version: versionEntryForAgentSchema }).strict(),
      )
      .describe('One entry per document, in the order asked for.'),
  })
  .strict()
export type VersionSaveOutput = z.infer<typeof versionSaveOutputSchema>

/**
 * Saves a version into the ONE history — the same rows the History panel
 * lists and the HTTP route writes — so a checkpoint an agent takes is
 * visible to the person watching, and survives the daemon restarting.
 *
 * The tool is addressed by `documentId` and the history by `path`, so every
 * placement is resolved FIRST, before any row is written. That ordering is
 * the whole reason a batch is safe to offer: each document is its own Loro
 * doc with its own history row and there is no transaction across them, so
 * saving as we go would leave a prefix of the batch checkpointed behind a
 * thrown error — and a caller who retried would get two rows for those
 * documents with no way to tell from the error that it had happened.
 * Resolving everything up front turns the failure that actually occurs (a
 * bad id, a workspace that does not own the document) into a refusal that
 * writes nothing. What resolution cannot rule out is the store failing
 * mid-write, which no ordering can undo.
 */
export function createVersionSaveTool(deps: ServerDeps) {
  return {
    name: 'wb_version_save' as const,
    description:
      'Save a labelled version of one or more documents into their history — the same history the History panel shows. One label covers the whole batch, so several documents become one checkpoint. Restore any of them later with wb_version_restore. A document the workspace does not own refuses the whole call before anything is recorded.',
    inputSchema: versionSaveInputSchema,
    outputSchema: versionSaveOutputSchema,
    async execute(input: VersionSaveInput): Promise<VersionSaveOutput> {
      // Parsed again here: the MCP boundary may rebuild validation without
      // `.strict()`, so the schema is the only guard on what reaches the seam.
      const { workspaceId, documentIds, label } = versionSaveInputSchema.parse(input)

      // Resolve every document before saving any. See the note above.
      const placements: { documentId: string; path: string }[] = []
      for (const documentId of documentIds) {
        const entry = await resolveDocumentInWorkspace(deps.documentIndex, workspaceId, documentId)
        placements.push({ documentId, path: entry.path })
      }

      const saved: VersionSaveOutput['saved'] = []
      for (const { documentId, path } of placements) {
        // The doc is read only for the row's advisory element count; the
        // checkpoint itself is the stored record's frontier, which the history
        // reads for itself.
        const doc = await loadOrCreateDocument(deps, workspaceId, documentId)
        const version = await deps.versions.save(workspaceId, path, doc, { auto: false, label })
        deps.clientNotifier?.versionCreated({ workspaceId, documentId, version })
        saved.push({ documentId, version: versionEntryForAgent(version) })
      }
      return { saved }
    },
  }
}
