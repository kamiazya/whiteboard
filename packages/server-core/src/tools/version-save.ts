import { canvasIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { encodeFrontiers } from 'loro-crdt'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadOrCreateCanvasDoc, saveDocSnapshot } from './canvas-doc-io.js'
import { generateCanvasId } from './generate-canvas-id.js'

export const versionSaveInputSchema = z
  .object({
    canvasId: canvasIdSchema,
    label: z.string().min(1).max(200),
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
    name: 'version_save' as const,
    inputSchema: versionSaveInputSchema,
    outputSchema: versionSaveOutputSchema,
    async execute(input: VersionSaveInput): Promise<VersionSaveOutput> {
      const doc = await loadOrCreateCanvasDoc(deps, input.canvasId)

      const versionId = generateCanvasId()
      const timestamp = new Date().toISOString()
      const frontierBytes = encodeFrontiers(doc.oplogFrontiers())
      const frontier = Array.from(frontierBytes, (b) => b.toString(16).padStart(2, '0')).join('')

      const versions = doc.getMap('versions')
      versions.set(versionId, JSON.stringify({ label: input.label, timestamp, frontier }))
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
