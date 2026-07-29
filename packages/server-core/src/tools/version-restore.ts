import { canvasIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { decodeFrontiers } from 'loro-crdt'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadOrCreateCanvasDoc, saveDocSnapshot } from './canvas-doc-io.js'
import { parseVersionRecord } from './version-record.js'
import { withReindex } from './with-reindex.js'
import { assertCanvasInWorkspace } from './workspace-tree-io.js'

export const versionRestoreInputSchema = z
  .object({
    workspaceId: workspaceIdSchema.describe('Workspace ID the target canvas belongs to.'),
    canvasId: canvasIdSchema.describe('Canvas ID (ULID) to restore a version onto, in place.'),
    versionId: z.string().min(1).describe('Version id returned by version_save or version_list.'),
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
    execute: withReindex(
      deps,
      async (input: VersionRestoreInput): Promise<VersionRestoreOutput> => {
        await assertCanvasInWorkspace(deps.canvasDocStore, input.workspaceId, input.canvasId)
        const doc = await loadOrCreateCanvasDoc(deps, input.canvasId)

        const versions = doc.getMap('versions')
        const raw = versions.get(input.versionId)
        if (typeof raw !== 'string') {
          throw new VersionNotFoundError(input.canvasId, input.versionId)
        }

        const record = parseVersionRecord(raw)
        if (record === null) {
          throw new VersionNotFoundError(input.canvasId, input.versionId)
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

        await saveDocSnapshot(deps, input.canvasId, doc)

        return {
          canvasId: input.canvasId,
          restoredVersionId: input.versionId,
          label,
          frontier,
        }
      },
    ),
  }
}
