import type { DaemonClient } from '../daemon-client.js'
import { parseCanvasId } from './canvas-id.js'

interface CanvasExportJsonArgs {
  canvasId: string
  includeCustomFields?: boolean
  outputPath?: string
  overwrite?: boolean
}

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
        outputPath: {
          type: 'string',
          description:
            'Absolute path to write the .excalidraw file to. Useful when round-tripping a local file. Parent directories are created as needed. When omitted, write to the workspace exports directory.',
        },
        overwrite: {
          type: 'boolean',
          description:
            'Replace an existing file at outputPath. Default: false. Without this, an existing outputPath is rejected with output_exists.',
        },
      },
      required: ['canvasId'],
    },
    execute: async (args: CanvasExportJsonArgs, client: DaemonClient) => {
      const { sessionId, slug } = parseCanvasId(args.canvasId)
      const body: {
        includeCustomFields: boolean
        outputPath?: string
        overwrite?: boolean
      } = {
        includeCustomFields: args.includeCustomFields === true,
      }
      if (args.outputPath !== undefined) body.outputPath = args.outputPath
      if (args.overwrite !== undefined) body.overwrite = args.overwrite

      const res = await client.request(
        `/api/canvas/${sessionId}/${encodeURIComponent(slug)}/export-json`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as
          | { error?: string; message?: string }
          | null
        // Prefer the human-readable message so the LLM sees enough context to
        // adjust outputPath instead of a bare error code.
        throw new Error(
          errBody?.message ?? errBody?.error ?? `Failed to export canvas JSON: ${res.status}`,
        )
      }
      return (await res.json()) as { filePath: string; elementCount: number }
    },
  }
}
