import { LoroDoc } from 'loro-crdt'
import { z } from 'zod'
import type { DaemonClient } from '../daemon-client.js'
import { parseCanvasId } from './canvas-id.js'
import { summarizeCanvas, type CanvasSummary } from './summarize-canvas.js'

export const canvasInspectOutputSchema = z.object({
  elementCount: z.number(),
  elements: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      angle: z.number().optional(),
      fileId: z.string().optional(),
      text: z.string().optional(),
      strokeColor: z.string().optional(),
      backgroundColor: z.string().optional(),
      isDeleted: z.boolean().optional(),
    }),
  ),
})

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
    execute: async (args: { canvasId: string }, client: DaemonClient): Promise<CanvasSummary> => {
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
