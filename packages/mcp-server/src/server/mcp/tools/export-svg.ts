import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import { exportSvgResponseSchema } from '../../../shared/api-contracts/export-svg.js'
import type { DaemonClient } from '../daemon-client.js'
import { parseCanvasId } from './canvas-id.js'

export const exportSvgOutputSchema = z.object({
  filePath: z.string(),
  svgMarkup: z.string().optional(),
})

// SVG markup is text, typically well under a megabyte even for large
// canvases, but cap inlining anyway so a pathological scene cannot balloon
// the MCP response the same way an uncapped PNG base64 blob could.
const DEFAULT_MAX_INLINE_SVG_BYTES = 2 * 1024 * 1024

function resolveMaxInlineSvgBytes(): number {
  const raw = process.env.WHITEBOARD_EXPORT_MAX_SVG_BYTES
  if (!raw) return DEFAULT_MAX_INLINE_SVG_BYTES
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_INLINE_SVG_BYTES
}

function buildExportSvgBody(args: ExportSvgArgs): Record<string, number | string | boolean> {
  const body: Record<string, number | string | boolean> = {}
  if (args.padding !== undefined) body.padding = args.padding
  if (args.frameId !== undefined) body.frameId = args.frameId
  if (args.outputPath !== undefined) body.outputPath = args.outputPath
  if (args.overwrite !== undefined) body.overwrite = args.overwrite
  if (args.theme !== undefined) body.theme = args.theme
  return body
}

export const exportSvgInputShape = {
  canvasId: z.string().describe('Canvas ID in "{workspaceId}/{slug}" form.'),
  padding: z
    .number()
    .optional()
    .describe('Padding (px) around all elements in the exported SVG. Default 10.'),
  frameId: z
    .string()
    .optional()
    .describe(
      'When set, export only the frame and its children. Useful for section-scoped exports on large canvases.',
    ),
  outputPath: z
    .string()
    .optional()
    .describe(
      "Absolute path to write the SVG to. Must be inside this workspace's exports directory (~/.whiteboard/<workspaceId>/exports, or $WHITEBOARD_DATA_DIR/<workspaceId>/exports if that env var is set) — paths outside it are rejected with invalid_output_path. Parent directories inside that root are created as needed. Omit outputPath to write to the default location there automatically.",
    ),
  overwrite: z
    .boolean()
    .optional()
    .describe(
      'Replace an existing file at outputPath. Default false; without it an existing outputPath is rejected with output_exists.',
    ),
  theme: z
    .enum(['light', 'dark'])
    .optional()
    .describe(
      'Force the rendered scene into "light" or "dark" without mutating the persisted appState.',
    ),
} satisfies z.ZodRawShape

const exportSvgInputSchema = z.object(exportSvgInputShape)
type ExportSvgArgs = z.infer<typeof exportSvgInputSchema>

export function exportSvgTool() {
  return {
    name: 'export_svg',
    description:
      'Export the whiteboard canvas as an SVG file, rendered headlessly straight from the persisted document (no browser connection required).',
    inputSchema: z.toJSONSchema(exportSvgInputSchema) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: ExportSvgArgs,
      client: DaemonClient,
    ): Promise<z.infer<typeof exportSvgOutputSchema>> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const body = buildExportSvgBody(args)
      const res = await client.request(
        `/api/canvas/${workspaceId}/${encodeURIComponent(slug)}/export-svg`,
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
        throw new Error(
          errBody?.message ?? errBody?.error ?? `Failed to export canvas SVG: ${res.status}`,
        )
      }
      const json = exportSvgResponseSchema.parse(await res.json())
      let svgMarkup: string | undefined
      try {
        const cap = resolveMaxInlineSvgBytes()
        const info = await stat(json.filePath)
        if (info.size <= cap) {
          svgMarkup = await readFile(json.filePath, 'utf-8')
        }
      } catch {
        svgMarkup = undefined
      }
      return svgMarkup !== undefined
        ? { filePath: json.filePath, svgMarkup }
        : { filePath: json.filePath }
    },
  }
}
