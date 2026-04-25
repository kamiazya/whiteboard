import type { DaemonClient } from '../daemon-client.js'
import { parseCanvasId } from './canvas-id.js'
export function canvasExportJsonTool() {
  return {
    name: 'canvas_export_json',
    description:
      'Export the canvas as a standard Excalidraw JSON (.excalidraw) file that can be opened in the Excalidraw desktop app, excalidraw.com, or any tool reading the official schema. Our internal custom fields (parentId / relX / relY) are resolved into absolute x/y and stripped by default.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
        includeCustomFields: {
          type: 'boolean',
          description:
            'Keep internal custom fields (parentId / relX / relY) in the exported JSON. Default: false. Set true for debugging or round-tripping through this tool.',
        },
      },
      required: ['canvasId'],
    },
    execute: async (
      args: { canvasId: string; includeCustomFields?: boolean },
      client: DaemonClient,
    ) => {
      const { sessionId, slug } = parseCanvasId(args.canvasId)
      const res = await client.request(`/api/canvas/${sessionId}/${encodeURIComponent(slug)}/export-json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          includeCustomFields: args.includeCustomFields === true,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `Failed to export canvas JSON: ${res.status}`)
      }
      return (await res.json()) as { filePath: string; elementCount: number }
    },
  }
}
