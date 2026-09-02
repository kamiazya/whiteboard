import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { restoreVersion } from '../operations/restore-version.js'
import type { ServerDeps } from '../server-deps.js'
import { resolveDocumentInWorkspace } from './assert-document-in-workspace.js'

export const versionRestoreInputSchema = z
  .object({
    workspaceId: workspaceIdSchema.describe('Workspace ID the document belongs to.'),
    documentId: documentIdSchema.describe(
      'Document ID (ULID) to restore a version onto, in place.',
    ),
    versionId: z
      .string()
      .min(1)
      .describe('Version id (`version.id`) returned by wb_version_save or wb_version_list.'),
  })
  .strict()
export type VersionRestoreInput = z.infer<typeof versionRestoreInputSchema>

export const versionRestoreOutputSchema = z
  .object({
    documentId: documentIdSchema,
    restoredVersionId: z.string(),
    label: z.string().optional(),
  })
  .strict()
export type VersionRestoreOutput = z.infer<typeof versionRestoreOutputSchema>

export class VersionNotFoundError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly versionId: string,
  ) {
    super(`version not found: ${versionId} in document ${documentId}`)
    this.name = 'VersionNotFoundError'
  }
}

/**
 * The MCP surface of `restoreVersion`, in-place mode: the same operation the
 * History panel's Restore button reaches over HTTP, so an agent rolling back
 * and a person rolling back get one answer. A watching browser is told
 * through the notifier the way it is told by the route.
 */
export function createVersionRestoreTool(deps: ServerDeps) {
  return {
    name: 'wb_version_restore' as const,
    description:
      'Restore a document to one of its saved versions, in place. Nothing rewinds: the restore is a new edit whose result equals the saved state.',
    inputSchema: versionRestoreInputSchema,
    outputSchema: versionRestoreOutputSchema,
    execute: async (input: VersionRestoreInput): Promise<VersionRestoreOutput> => {
      const { workspaceId, documentId, versionId } = input
      const entry = await resolveDocumentInWorkspace(deps.documentIndex, workspaceId, documentId)
      // The operation looks the label up for its `started` event; reading it
      // from there is what keeps the tool's answer and the overlay's caption
      // the same string.
      let label: string | undefined
      const result = await restoreVersion(
        deps,
        { workspaceId, path: entry.path, versionId },
        (event) => {
          if (event.phase === 'started') label = event.label
          deps.clientNotifier?.restoreProgress(event)
        },
      )
      switch (result.kind) {
        case 'restored-in-place':
          return {
            documentId,
            restoredVersionId: versionId,
            ...(label === undefined ? {} : { label }),
          }
        case 'not-found':
          throw new VersionNotFoundError(documentId, versionId)
        default:
          // Neither a target nor a subtree was asked for, so the other
          // refusals and results cannot occur.
          throw new Error(`unexpected restore result for an in-place restore: ${result.kind}`)
      }
    },
  }
}
