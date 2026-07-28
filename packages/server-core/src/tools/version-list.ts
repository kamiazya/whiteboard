import { canvasIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadOrCreateCanvasDoc } from './canvas-doc-io.js'

const versionEntrySchema = z
  .object({
    versionId: z.string(),
    label: z.string(),
    timestamp: z.string(),
    frontier: z.string(),
  })
  .strict()

export const versionListInputSchema = z
  .object({
    canvasId: canvasIdSchema,
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
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>
          const { label, timestamp, frontier } = parsed
          if (
            typeof label === 'string' &&
            typeof timestamp === 'string' &&
            typeof frontier === 'string'
          ) {
            entries.push({ versionId, label, timestamp, frontier })
          }
        } catch {
          continue
        }
      }

      entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

      return { canvasId: input.canvasId, versions: entries }
    },
  }
}
