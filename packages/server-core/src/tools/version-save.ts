import { documentIdSchema, generateDocumentId } from '@kamiazya/whiteboard-canvas-model'
import { encodeFrontiers } from 'loro-crdt'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadOrCreateDocument, saveDocumentSnapshot } from './document-io.js'
import { versionRecordSchema } from './version-record.js'

export const versionSaveInputSchema = z
  .object({
    documentId: documentIdSchema.describe('Canvas ID (ULID) to save a version of.'),
    label: z.string().min(1).max(200).describe('Human-readable label for this version.'),
  })
  .strict()
export type VersionSaveInput = z.infer<typeof versionSaveInputSchema>

export const versionSaveOutputSchema = z
  .object({
    documentId: documentIdSchema,
    versionId: z.string(),
    label: z.string(),
    timestamp: z.string(),
    frontier: z.string(),
  })
  .strict()
export type VersionSaveOutput = z.infer<typeof versionSaveOutputSchema>

export function createVersionSaveTool(deps: ServerDeps) {
  return {
    name: 'wb_version_save' as const,
    description: 'Save a labelled version of a document.',
    inputSchema: versionSaveInputSchema,
    outputSchema: versionSaveOutputSchema,
    async execute(input: VersionSaveInput): Promise<VersionSaveOutput> {
      const doc = await loadOrCreateDocument(deps, input.documentId)

      const versionId = generateDocumentId()
      const timestamp = new Date().toISOString()
      const frontierBytes = encodeFrontiers(doc.oplogFrontiers())
      const frontier = Array.from(frontierBytes, (b) => b.toString(16).padStart(2, '0')).join('')

      const versions = doc.getMap('versions')
      const record = versionRecordSchema.parse({ label: input.label, timestamp, frontier })
      versions.set(versionId, JSON.stringify(record))
      doc.commit()

      await saveDocumentSnapshot(deps, input.documentId, doc)

      return {
        documentId: input.documentId,
        versionId,
        label: input.label,
        timestamp,
        frontier,
      }
    },
  }
}
