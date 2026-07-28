import { canvasIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { decodeFrontiers } from 'loro-crdt'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadOrCreateCanvasDoc, saveDocSnapshot } from './canvas-doc-io.js'

export const versionRestoreInputSchema = z
  .object({
    canvasId: canvasIdSchema,
    versionId: z.string().min(1),
  })
  .strict()
export type VersionRestoreInput = z.infer<typeof versionRestoreInputSchema>

export const versionRestoreOutputSchema = z
  .object({
    canvasId: canvasIdSchema,
    restoredVersionId: z.string(),
    label: z.string(),
    frontier: z.string(),
  })
  .strict()
export type VersionRestoreOutput = z.infer<typeof versionRestoreOutputSchema>

export class VersionNotFoundError extends Error {
  constructor(
    public readonly canvasId: string,
    public readonly versionId: string,
  ) {
    super(`version not found: ${versionId} in canvas ${canvasId}`)
    this.name = 'VersionNotFoundError'
  }
}

export function createVersionRestoreTool(deps: ServerDeps) {
  return {
    name: 'version_restore' as const,
    inputSchema: versionRestoreInputSchema,
    outputSchema: versionRestoreOutputSchema,
    async execute(input: VersionRestoreInput): Promise<VersionRestoreOutput> {
      const doc = await loadOrCreateCanvasDoc(deps, input.canvasId)

      const versions = doc.getMap('versions')
      const raw = versions.get(input.versionId)
      if (typeof raw !== 'string') {
        throw new VersionNotFoundError(input.canvasId, input.versionId)
      }

      let label: string
      let frontier: string
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (typeof parsed.label !== 'string' || typeof parsed.frontier !== 'string') {
          throw new VersionNotFoundError(input.canvasId, input.versionId)
        }
        label = parsed.label
        frontier = parsed.frontier
      } catch {
        throw new VersionNotFoundError(input.canvasId, input.versionId)
      }

      const frontierBytes = new Uint8Array(
        (frontier.match(/.{2}/g) ?? []).map((h) => Number.parseInt(h, 16)),
      )
      const targetFrontiers = decodeFrontiers(frontierBytes)

      doc.checkout(targetFrontiers)
      const oldCanvas = readSpatialCanvas(doc)
      doc.checkoutToLatest()

      writeSpatialCanvas(doc, oldCanvas)
      doc.commit()

      await saveDocSnapshot(deps, input.canvasId, doc)

      return {
        canvasId: input.canvasId,
        restoredVersionId: input.versionId,
        label,
        frontier,
      }
    },
  }
}
