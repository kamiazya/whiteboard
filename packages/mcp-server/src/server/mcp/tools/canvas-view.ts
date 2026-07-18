import { LoroDoc } from 'loro-crdt'
import { z } from 'zod'
import { resolveParentedElements } from '../../../shared/resolve-parented-elements.js'
import { loroRawElementSchema, validateLoroRawElements } from '../../../shared/loro-raw-element.js'
import { getLogger } from '../../log.js'
import type { DaemonClient } from '../daemon-client.js'
import { parseCanvasId } from './canvas-id.js'

// Scene shape mirrors packages/canvas-viewer's viewerSceneSchema
// ({elements, appState?, files?}, .strict()) so the widget's
// parseViewerScene accepts this structuredContent verbatim — no adapter
// layer between this tool and the widget. appState/files are omitted here
// (undefined, not present) because the daemon's Loro document only
// persists the elements list; the widget falls back to its own defaults.
const canvasViewSceneSchema = z
  .object({
    elements: z.array(loroRawElementSchema),
  })
  .strict()

export const canvasViewOutputSchema = z.object({
  canvasId: z.string(),
  scene: canvasViewSceneSchema,
})

export const canvasViewInputShape = {
  canvasId: z
    .string()
    .describe(
      'Canvas ID in "{workspaceId}/{slug}" form. Returns a read-only scene snapshot (elements only, no daemon credentials) rendered as an interactive canvas view inline in the chat.',
    ),
} satisfies z.ZodRawShape

export function canvasViewTool() {
  return {
    name: 'canvas_view',
    description:
      'Render a read-only, interactive view of a whiteboard canvas inline in the chat (MCP Apps ui:// widget). Returns the current scene snapshot; the widget can pan/zoom/select but never mutates the canvas or receives daemon credentials.',
    inputSchema: z.toJSONSchema(z.object(canvasViewInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: { canvasId: string },
      client: DaemonClient,
    ): Promise<z.infer<typeof canvasViewOutputSchema>> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const res = await client.request(
        `/api/canvas/${workspaceId}/${encodeURIComponent(slug)}/snapshot`,
      )
      if (!res.ok) {
        throw new Error(`Failed to fetch snapshot: ${res.status} ${res.statusText}`)
      }
      const bytes = new Uint8Array(await res.arrayBuffer())
      const doc = new LoroDoc()
      doc.import(bytes)
      const raw = doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>
      const log = getLogger('canvas-view')
      const validated = validateLoroRawElements(raw, ({ index, error }) => {
        log.warning({ index, reason: error.issues[0]?.message }, 'dropped corrupt element')
      })
      const resolved = resolveParentedElements(validated)
      const elements = resolved.filter((el) => el.isDeleted !== true)
      return { canvasId: args.canvasId, scene: { elements } }
    },
  }
}
