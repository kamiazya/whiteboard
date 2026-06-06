import { LoroDoc } from 'loro-crdt'
import type { z } from 'zod'
import type { DaemonClient } from '../daemon-client.js'
import { parseCanvasId } from './canvas-id.js'
import { type canvasInspectOutputSchema, summarizeCanvas } from './summarize-canvas.js'

export { canvasInspectOutputSchema } from './summarize-canvas.js'

export function canvasInspectTool() {
  return {
    name: 'canvas_inspect',
    description:
      'Inspect the current state of a whiteboard canvas. Returns element count and summaries (id, type, position, size, key attributes) so Claude can decide where to place annotations or verify prior operations.',
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
