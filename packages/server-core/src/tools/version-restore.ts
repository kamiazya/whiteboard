import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { decodeFrontiers } from 'loro-crdt'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { assertCanvasInWorkspace } from './assert-canvas-in-workspace.js'
import { loadOrCreateDocument, saveDocumentSnapshot } from './document-io.js'
import { parseVersionRecord } from './version-record.js'

export const versionRestoreInputSchema = z
  .object({
    workspaceId: workspaceIdSchema.describe('Workspace ID the target canvas belongs to.'),
    documentId: documentIdSchema.describe('Canvas ID (ULID) to restore a version onto, in place.'),
    versionId: z
      .string()
      .min(1)
      .describe('Version id returned by wb_version_save or wb_version_list.'),
  })
  .strict()
export type VersionRestoreInput = z.infer<typeof versionRestoreInputSchema>

export const versionRestoreOutputSchema = z
  .object({
    documentId: documentIdSchema,
    restoredVersionId: z.string(),
    label: z.string(),
    frontier: z.string(),
  })
  .strict()
export type VersionRestoreOutput = z.infer<typeof versionRestoreOutputSchema>

export class VersionNotFoundError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly versionId: string,
  ) {
    super(`version not found: ${versionId} in canvas ${documentId}`)
    this.name = 'VersionNotFoundError'
  }
}

export function createVersionRestoreTool(deps: ServerDeps) {
  return {
    name: 'wb_version_restore' as const,
    description: 'Restore a document to one of its saved versions.',
    inputSchema: versionRestoreInputSchema,
    outputSchema: versionRestoreOutputSchema,
    execute: async (input: VersionRestoreInput): Promise<VersionRestoreOutput> => {
      await assertCanvasInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)
      const doc = await loadOrCreateDocument(deps, input.documentId)

      const versions = doc.getMap('versions')
      const raw = versions.get(input.versionId)
      if (typeof raw !== 'string') {
        throw new VersionNotFoundError(input.documentId, input.versionId)
      }

      const record = parseVersionRecord(raw)
      if (record === null) {
        throw new VersionNotFoundError(input.documentId, input.versionId)
      }
      const { label, frontier } = record

      const frontierBytes = new Uint8Array(
        (frontier.match(/.{2}/g) ?? []).map((h) => Number.parseInt(h, 16)),
      )
      const targetFrontiers = decodeFrontiers(frontierBytes)

      doc.checkout(targetFrontiers)
      const oldCanvas = readSpatialCanvas(doc)
      doc.checkoutToLatest()

      writeSpatialCanvas(doc, oldCanvas)
      doc.commit()

      await saveDocumentSnapshot(deps, input.documentId, doc)

      return {
        documentId: input.documentId,
        restoredVersionId: input.versionId,
        label,
        frontier,
      }
    },
  }
}
