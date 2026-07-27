import { z } from 'zod'
import type { DaemonClient } from '../daemon-client.js'
import { exportPngTool } from './export.js'
import { exportSvgTool } from './export-svg.js'

// Unifies the per-format export tools (png / svg) behind one `format`
// switch. This is the only registered MCP export tool — the project is
// pre-1.0 with no external users to keep a deprecated dual surface for
// (ADR-0001).
export const exportCanvasOutputSchema = z.object({
  format: z.enum(['png', 'svg']),
  filePath: z.string(),
  imageBase64: z.string().optional(),
  svgMarkup: z.string().optional(),
})

interface ExportCanvasArgs {
  canvasId: string
  format: 'png' | 'svg'
  padding?: number
  scale?: number
  minFontPx?: number
  frameId?: string
  outputPath?: string
  overwrite?: boolean
  theme?: 'light' | 'dark'
}

export const exportCanvasInputShape = {
  canvasId: z
    .string()
    .describe(
      'Canvas ID in "{workspaceId}/{slug}" form. For format:"png", the browser must be connected (call canvas_open first) unless no client is connected, in which case it falls back to headless rendering.',
    ),
  format: z
    .enum(['png', 'svg'])
    .describe(
      'Output format. "png": raster image (prefers the connected browser, falls back to headless). "svg": vector image, always rendered headless from the persisted document.',
    ),
  padding: z
    .number()
    .optional()
    .describe(
      'PNG/SVG only. Padding (px) around all elements in the exported image. Default 10. Use 24-48 to avoid cropping annotation strokes / text.',
    ),
  scale: z
    .number()
    .optional()
    .describe(
      'PNG only. Export scale factor (appState.exportScale). Default 1. Use 2-3 for high-DPI exports of large canvases. Ignored for svg (SVG is resolution-independent).',
    ),
  minFontPx: z
    .number()
    .optional()
    .describe(
      'PNG only. Minimum font size (px) enforced on text elements before export. Original scene unchanged.',
    ),
  frameId: z
    .string()
    .optional()
    .describe(
      'PNG/SVG only. When set, export only the frame and its children. Useful for section-scoped exports on large canvases.',
    ),
  outputPath: z
    .string()
    .optional()
    .describe(
      "Absolute path to write the exported file to. Must be inside this workspace's exports directory (~/.whiteboard/<workspaceId>/exports, or $WHITEBOARD_DATA_DIR/<workspaceId>/exports if that env var is set) — paths outside it are rejected with invalid_output_path. Omit to write to the default location there automatically.",
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
      'PNG/SVG only. Force the rendered scene into "light" or "dark" without mutating the persisted appState.',
    ),
} satisfies z.ZodRawShape

export function exportCanvasTool() {
  return {
    name: 'export_canvas',
    description: 'Unified canvas export: choose format "png" | "svg" in one tool.',
    inputSchema: z.toJSONSchema(z.object(exportCanvasInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: ExportCanvasArgs,
      client: DaemonClient,
    ): Promise<z.infer<typeof exportCanvasOutputSchema>> => {
      if (args.format === 'svg') {
        const result = await exportSvgTool().execute(
          {
            canvasId: args.canvasId,
            padding: args.padding,
            frameId: args.frameId,
            outputPath: args.outputPath,
            overwrite: args.overwrite,
            theme: args.theme,
          },
          client,
        )
        return { format: 'svg', filePath: result.filePath, svgMarkup: result.svgMarkup }
      }
      if (args.format === 'png') {
        const result = await exportPngTool().execute(
          {
            canvasId: args.canvasId,
            padding: args.padding,
            scale: args.scale,
            minFontPx: args.minFontPx,
            frameId: args.frameId,
            outputPath: args.outputPath,
            overwrite: args.overwrite,
            theme: args.theme,
          },
          client,
        )
        return { format: 'png', filePath: result.filePath, imageBase64: result.imageBase64 }
      }
      // The registered MCP tool's inputSchema (a Zod enum) rejects an
      // out-of-enum format before this ever runs, but `format` is the whole
      // contract of this tool — a caller that reaches here with anything
      // else must get a loud failure, never a silent fallback to a format
      // that was not requested.
      throw new Error(`Unsupported format: ${String(args.format)}`)
    },
  }
}
