import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { versionEntrySchema } from '../versions/version-entry.js'
import { resolveDocumentInWorkspace } from './assert-document-in-workspace.js'
import { loadOrCreateDocument } from './document-io.js'

export const versionSaveInputSchema = z
  .object({
    workspaceId: workspaceIdSchema.describe('Workspace that holds the document.'),
    documentId: documentIdSchema.describe('Document ID (ULID) to save a version of.'),
    label: z.string().min(1).max(200).describe('Human-readable label for this version.'),
  })
  .strict()
export type VersionSaveInput = z.infer<typeof versionSaveInputSchema>

export const versionSaveOutputSchema = z
  .object({
    documentId: documentIdSchema,
    /** The row as the History panel lists it; `version.id` is what wb_version_restore takes. */
    version: versionEntrySchema,
  })
  .strict()
export type VersionSaveOutput = z.infer<typeof versionSaveOutputSchema>

/**
 * Saves a version into the ONE history — the same rows the History panel
 * lists and the HTTP route writes — so a checkpoint an agent takes is
 * visible to the person watching, and survives the daemon restarting.
 *
 * The tool is addressed by `documentId` and the history by `path`, so the
 * placement is resolved first; a `workspaceId` that does not own the
 * document is refused before anything is recorded.
 */
export function createVersionSaveTool(deps: ServerDeps) {
  return {
    name: 'wb_version_save' as const,
    description:
      'Save a labelled version of a document into its history — the same history the History panel shows. Restore it later with wb_version_restore.',
    inputSchema: versionSaveInputSchema,
    outputSchema: versionSaveOutputSchema,
    async execute(input: VersionSaveInput): Promise<VersionSaveOutput> {
      // Parsed again here: the MCP boundary may rebuild validation without
      // `.strict()`, so the schema is the only guard on what reaches the seam.
      const { workspaceId, documentId, label } = versionSaveInputSchema.parse(input)
      const entry = await resolveDocumentInWorkspace(deps.documentIndex, workspaceId, documentId)
      // The doc is read only for the row's advisory element count; the
      // checkpoint itself is the stored record's frontier, which the history
      // reads for itself.
      const doc = await loadOrCreateDocument(deps, workspaceId, documentId)
      const version = await deps.versions.save(workspaceId, entry.path, doc, {
        auto: false,
        label,
      })
      deps.clientNotifier?.versionCreated({ workspaceId, documentId, version })
      return { documentId, version }
    },
  }
}
