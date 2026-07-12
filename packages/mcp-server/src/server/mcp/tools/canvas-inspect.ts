import { LoroDoc } from 'loro-crdt'
import { z } from 'zod'
import type { DaemonClient } from '../daemon-client.js'
import { parseCanvasId } from './canvas-id.js'
import { type canvasInspectOutputSchema, summarizeCanvas } from './summarize-canvas.js'

export { canvasInspectOutputSchema } from './summarize-canvas.js'

export const canvasInspectInputShape = {
  canvasId: z
    .string()
    .describe(
      'Canvas ID in "{workspaceId}/{slug}" form. Returns elementCount + per-element { id, type, x, y, width, height, ... } for inspecting structure / debugging.',
    ),
} satisfies z.ZodRawShape

export function canvasInspectTool() {
  return {
    name: 'canvas_inspect',
    description:
      'Inspect the current state of a whiteboard canvas. Returns elementCount (raw Excalidraw node count — composite annotations like box_with_label expand to multiple nodes, so this is higher than the number of annotate() calls) and per-element summaries (id, type, position, size, key attributes) so Claude can decide where to place annotations or verify prior operations.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
      },
      required: ['canvasId'],
    },
    execute: async (
      args: { canvasId: string },
      client: DaemonClient,
    ): Promise<z.infer<typeof canvasInspectOutputSchema>> => {
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
      return summarizeCanvas(doc)
    },
  }
}
