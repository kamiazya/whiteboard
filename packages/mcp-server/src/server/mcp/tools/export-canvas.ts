import { z } from 'zod'
import type { DaemonClient } from '../daemon-client.js'
import { canvasExportJsonTool } from './canvas-export-json.js'
import { exportPngTool } from './export.js'
import { exportSvgTool } from './export-svg.js'

// Unifies the three per-format export tools (export_png / export_svg /
// canvas_export_json) behind one `format` switch. This is the single source
// of the export contract going forward; export_png and canvas_export_json
// stay registered (unchanged, non-breaking) for existing callers of the
// published npm package, but their descriptions point here. Rather than
// re-implement each format's HTTP/output-path/error-handling logic a third
// time, this tool delegates straight to the existing per-format tool
// builders — one implementation per format, shared by both the legacy tool
// name and this one.
export const exportCanvasOutputSchema = z.object({
  format: z.enum(['png', 'svg', 'json']),
  filePath: z.string(),
  imageBase64: z.string().optional(),
  svgMarkup: z.string().optional(),
  elementCount: z.number().optional(),
})

interface ExportCanvasArgs {
  canvasId: string
  format: 'png' | 'svg' | 'json'
  padding?: number
  scale?: number
  minFontPx?: number
  frameId?: string
  outputPath?: string
  overwrite?: boolean
  theme?: 'light' | 'dark'
  includeCustomFields?: boolean
}

export const exportCanvasInputShape = {
  canvasId: z
    .string()
    .describe(
      'Canvas ID in "{workspaceId}/{slug}" form. For format:"png", the browser must be connected (call canvas_open first) unless no client is connected, in which case it falls back to headless rendering.',
    ),
  format: z
    .enum(['png', 'svg', 'json'])
    .describe(
      'Output format. "png": raster image (prefers the connected browser, falls back to headless). "svg": vector image, always rendered headless from the persisted document. "json": standard .excalidraw JSON, always rendered headless.',
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
      'PNG only. Export scale factor (appState.exportScale). Default 1. Use 2-3 for high-DPI exports of large canvases. Ignored for svg/json (SVG is resolution-independent).',
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
  includeCustomFields: z
    .boolean()
    .optional()
    .describe(
      'JSON only. Keep internal custom fields (parentId / relX / relY) in the exported JSON. Default: false.',
    ),
} satisfies z.ZodRawShape

export function exportCanvasTool() {
  return {
    name: 'export_canvas',
    description:
      'Unified canvas export: choose format "png" | "svg" | "json" in one tool. Prefer this over the deprecated export_png / canvas_export_json tools.',
    inputSchema: z.toJSONSchema(z.object(exportCanvasInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: ExportCanvasArgs,
      client: DaemonClient,
    ): Promise<z.infer<typeof exportCanvasOutputSchema>> => {
      if (args.format === 'json') {
        const result = await canvasExportJsonTool().execute(
          {
            canvasId: args.canvasId,
            includeCustomFields: args.includeCustomFields,
            outputPath: args.outputPath,
            overwrite: args.overwrite,
          },
          client,
        )
        return { format: 'json', filePath: result.filePath, elementCount: result.elementCount }
      }
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
    },
  }
}
