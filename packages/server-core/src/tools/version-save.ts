import { canvasIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { encodeFrontiers } from 'loro-crdt'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadOrCreateCanvasDoc, saveDocSnapshot } from './canvas-doc-io.js'
import { generateCanvasId } from './generate-canvas-id.js'
import { versionRecordSchema } from './version-record.js'

export const versionSaveInputSchema = z
  .object({
    canvasId: canvasIdSchema.describe('Canvas ID (ULID) to save a version of.'),
    label: z.string().min(1).max(200).describe('Human-readable label for this version.'),
  })
  .strict()
export type VersionSaveInput = z.infer<typeof versionSaveInputSchema>

export const versionSaveOutputSchema = z
  .object({
    canvasId: canvasIdSchema,
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
      const doc = await loadOrCreateCanvasDoc(deps, input.canvasId)

      const versionId = generateCanvasId()
      const timestamp = new Date().toISOString()
      const frontierBytes = encodeFrontiers(doc.oplogFrontiers())
      const frontier = Array.from(frontierBytes, (b) => b.toString(16).padStart(2, '0')).join('')

      const versions = doc.getMap('versions')
      const record = versionRecordSchema.parse({ label: input.label, timestamp, frontier })
      versions.set(versionId, JSON.stringify(record))
      doc.commit()

      await saveDocSnapshot(deps, input.canvasId, doc)

      return {
        canvasId: input.canvasId,
        versionId,
        label: input.label,
        timestamp,
        frontier,
      }
    },
  }
}
