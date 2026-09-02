import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { versionEntrySchema } from '../versions/version-entry.js'
import { resolveDocumentInWorkspace } from './assert-document-in-workspace.js'

export const versionListInputSchema = z
  .object({
    workspaceId: workspaceIdSchema.describe('Workspace that holds the document.'),
    documentId: documentIdSchema.describe('Document ID (ULID) to list saved versions for.'),
  })
  .strict()
export type VersionListInput = z.infer<typeof versionListInputSchema>

export const versionListOutputSchema = z
  .object({
    documentId: documentIdSchema,
    /** Newest first. Includes automatic checkpoints (`auto: true`) and versions saved by people. */
    versions: z.array(versionEntrySchema),
  })
  .strict()
export type VersionListOutput = z.infer<typeof versionListOutputSchema>

export function createVersionListTool(deps: ServerDeps) {
  return {
    name: 'wb_version_list' as const,
    description:
      'List the saved versions of a document, newest first — the same list the History panel shows, including automatic checkpoints.',
    inputSchema: versionListInputSchema,
    outputSchema: versionListOutputSchema,
    async execute(input: VersionListInput): Promise<VersionListOutput> {
      const { workspaceId, documentId } = input
      const entry = await resolveDocumentInWorkspace(deps.documentIndex, workspaceId, documentId)
      const versions = await deps.versions.list(workspaceId, entry.path)
      return { documentId, versions: [...versions] }
    },
  }
}
