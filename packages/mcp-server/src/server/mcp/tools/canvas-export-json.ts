import { z } from 'zod'
import type { DaemonClient } from '../daemon-client.js'
import { parseCanvasId } from './canvas-id.js'

export const canvasExportJsonOutputSchema = z.object({
  filePath: z.string(),
  elementCount: z.number(),
})

interface CanvasExportJsonArgs {
  canvasId: string
  includeCustomFields?: boolean
  outputPath?: string
  overwrite?: boolean
}

export const canvasExportJsonInputShape = {
  canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
  includeCustomFields: z
    .boolean()
    .optional()
    .describe(
      'Keep internal custom fields (parentId / relX / relY) in the exported JSON. Default: false. Set true for debugging or round-tripping through this tool.',
    ),
  outputPath: z
    .string()
    .optional()
    .describe(
      "Absolute path to write the .excalidraw file to. Must be inside this workspace's exports directory (~/.whiteboard/<workspaceId>/exports, or $WHITEBOARD_DATA_DIR/<workspaceId>/exports if that env var is set) — paths outside it are rejected with invalid_output_path. Parent directories inside that root are created as needed. Omit outputPath to write to the default location there automatically.",
    ),
  overwrite: z
    .boolean()
    .optional()
    .describe(
      'Replace an existing file at outputPath. Default: false. Without this, an existing outputPath is rejected with output_exists.',
    ),
} satisfies z.ZodRawShape

export function canvasExportJsonTool() {
  return {
    name: 'canvas_export_json',
    description:
      'Export the canvas as a standard Excalidraw JSON (.excalidraw) file that can be opened in the Excalidraw desktop app, excalidraw.com, or any tool reading the official schema. Our internal custom fields (parentId / relX / relY) are resolved into absolute x/y and stripped by default.',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(canvasExportJsonInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: CanvasExportJsonArgs,
      client: DaemonClient,
    ): Promise<z.infer<typeof canvasExportJsonOutputSchema>> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
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
        `/api/canvas/${workspaceId}/${encodeURIComponent(slug)}/export-json`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as {
          error?: string
          message?: string
        } | null
        // Prefer the human-readable message so the LLM sees enough context to
        // adjust outputPath instead of a bare error code.
        throw new Error(
          errBody?.message ?? errBody?.error ?? `Failed to export canvas JSON: ${res.status}`,
        )
      }
      return canvasExportJsonOutputSchema.parse(await res.json())
    },
  }
}
