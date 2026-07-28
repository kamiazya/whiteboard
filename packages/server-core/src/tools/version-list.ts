import { canvasIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadOrCreateCanvasDoc } from './canvas-doc-io.js'
import { parseVersionRecord, versionRecordSchema } from './version-record.js'

const versionEntrySchema = versionRecordSchema.extend({
  versionId: z.string(),
})

export const versionListInputSchema = z
  .object({
    canvasId: canvasIdSchema.describe('Canvas ID (ULID) to list saved versions for.'),
  })
  .strict()
export type VersionListInput = z.infer<typeof versionListInputSchema>

export const versionListOutputSchema = z
  .object({
    canvasId: canvasIdSchema,
    versions: z.array(versionEntrySchema),
  })
  .strict()
export type VersionListOutput = z.infer<typeof versionListOutputSchema>

export function createVersionListTool(deps: ServerDeps) {
  return {
    name: 'version_list' as const,
    inputSchema: versionListInputSchema,
    outputSchema: versionListOutputSchema,
    async execute(input: VersionListInput): Promise<VersionListOutput> {
      const doc = await loadOrCreateCanvasDoc(deps, input.canvasId)

      const versions = doc.getMap('versions')
      const entries: z.infer<typeof versionEntrySchema>[] = []

      for (const versionId of versions.keys()) {
        const raw = versions.get(versionId)
        if (typeof raw !== 'string') continue
        const record = parseVersionRecord(raw)
        if (record !== null) {
          entries.push({ versionId, ...record })
        }
      }

      entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

      return { canvasId: input.canvasId, versions: entries }
    },
  }
}
