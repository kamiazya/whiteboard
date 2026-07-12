import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import { clientCountResponseSchema } from '../../../shared/api-contracts/canvas-runtime.js'
import {
  type ExportErrorBody,
  exportErrorBodySchema,
  exportResponseSchema,
} from '../../../shared/api-contracts/export.js'
import type { DaemonClient } from '../daemon-client.js'
import { parseCanvasId } from './canvas-id.js'

export const exportPngOutputSchema = z.object({
  filePath: z.string(),
  imageBase64: z.string().optional(),
})

// Browser cold starts can take 1-3s locally and 4-5s in CI or remote setups,
// so export_png waits 5s instead of 3s to reduce flaky no_client failures.
const EXPORT_PNG_WAIT_TIMEOUT_MS = 5_000
const EXPORT_PNG_WAIT_INTERVAL_MS = 100

// Hard ceiling on PNG bytes we are willing to base64-encode and ship through
// MCP. base64 itself is ~1.33x and the SDK round-trips through JSON, so a 4 MiB
// raw PNG already costs ~6 MiB of strings and ~12 MiB of transient buffers.
// Above this cap, the tool returns only the file path so the caller can open
// the file directly. Override with WHITEBOARD_EXPORT_MAX_BASE64_BYTES.
const DEFAULT_MAX_BASE64_BYTES = 4 * 1024 * 1024

function resolveMaxBase64Bytes(): number {
  const raw = process.env.WHITEBOARD_EXPORT_MAX_BASE64_BYTES
  if (!raw) return DEFAULT_MAX_BASE64_BYTES
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_BASE64_BYTES
}

interface ExportPngArgs {
  canvasId: string
  padding?: number
  scale?: number
  minFontPx?: number
  frameId?: string
  outputPath?: string
  overwrite?: boolean
  theme?: 'light' | 'dark'
}

function buildExportBody(args: ExportPngArgs): Record<string, number | string | boolean> {
  const body: Record<string, number | string | boolean> = {}
  if (args.padding !== undefined) body.padding = args.padding
  if (args.scale !== undefined) body.scale = args.scale
  if (args.minFontPx !== undefined) body.minFontPx = args.minFontPx
  if (args.frameId !== undefined) body.frameId = args.frameId
  if (args.outputPath !== undefined) body.outputPath = args.outputPath
  if (args.overwrite !== undefined) body.overwrite = args.overwrite
  if (args.theme !== undefined) body.theme = args.theme
  return body
}

async function requestExport(
  client: DaemonClient,
  workspaceId: string,
  slug: string,
  body: Record<string, number | string | boolean>,
): Promise<Response> {
  return client.request(`/api/canvas/${workspaceId}/${encodeURIComponent(slug)}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function readExportErrorBody(res: Response): Promise<ExportErrorBody | null> {
  const raw = await res.json().catch(() => null)
  if (raw === null) return null
  const parsed = exportErrorBodySchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

async function waitForClientReady(
  client: DaemonClient,
  workspaceId: string,
  slug: string,
  timeoutMs: number = EXPORT_PNG_WAIT_TIMEOUT_MS,
): Promise<boolean> {
  const statusPath = `/api/canvas/${workspaceId}/${encodeURIComponent(slug)}/client-count`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await client.request(statusPath)
      if (res.ok) {
        const parsed = clientCountResponseSchema.safeParse(await res.json())
        if (parsed.success && (parsed.data.readyCount ?? parsed.data.count) > 0) return true
      }
    } catch {
      // Browser startup races are expected; keep polling until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, EXPORT_PNG_WAIT_INTERVAL_MS))
  }
  return false
}

function throwExportError(res: Response, body: ExportErrorBody | null): never {
  if (body?.error === 'no_client') {
    throw new Error(
      `${body.message ?? 'No browser client connected.'}${body.hint ? ` Hint: ${body.hint}` : ''}`,
    )
  }
  if (body?.error === 'timeout') {
    throw new Error(body.message ?? 'Export timed out.')
  }
  if (body?.error === 'invalid_output_path' || body?.error === 'output_exists') {
    throw new Error(body.message ?? body.error)
  }
  throw new Error(`Export failed: ${res.status} ${body?.message ?? 'unknown error'}`)
}

export const exportPngInputShape = {
  canvasId: z
    .string()
    .describe(
      'Canvas ID in "{workspaceId}/{slug}" form. Browser must be connected (call canvas_open first).',
    ),
  padding: z
    .number()
    .optional()
    .describe(
      'Padding (px) around all elements in the exported PNG. Default 10. Use 24-48 to avoid cropping annotation strokes / text.',
    ),
  scale: z
    .number()
    .optional()
    .describe(
      'Export scale factor (appState.exportScale). Default 1. Use 2-3 for high-DPI exports of large canvases.',
    ),
  minFontPx: z
    .number()
    .optional()
    .describe(
      'Minimum font size (px) enforced on text elements before export. Clones with Math.max(fontSize, minFontPx) so small annotation text stays legible. Original scene unchanged.',
    ),
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
      "Absolute path to write the PNG to. Must be inside this workspace's exports directory (~/.whiteboard/<workspaceId>/exports, or $WHITEBOARD_DATA_DIR/<workspaceId>/exports if that env var is set) — paths outside it are rejected with invalid_output_path. Parent directories inside that root are created as needed. Omit outputPath to write to the default location there automatically.",
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
      'Force the rendered scene into "light" or "dark" without mutating the persisted appState. Use it to export the same canvas under both themes for dark-mode QA or contrast review.',
    ),
} satisfies z.ZodRawShape

export function exportPngTool() {
  return {
    name: 'export_png',
    description: 'Export the whiteboard canvas as a PNG file',
    // Derived from the Zod shape so the JSON-Schema view can never drift from
    // what registerToolWithAnnotations actually validates against.
    inputSchema: z.toJSONSchema(z.object(exportPngInputShape)) as {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    },
    execute: async (
      args: ExportPngArgs,
      client: DaemonClient,
    ): Promise<z.infer<typeof exportPngOutputSchema>> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const body = buildExportBody(args)
      let res = await requestExport(client, workspaceId, slug, body)
      if (!res.ok) {
        let errBody = await readExportErrorBody(res)
        if (errBody?.error === 'no_client') {
          const ready = await waitForClientReady(client, workspaceId, slug)
          if (ready) {
            res = await requestExport(client, workspaceId, slug, body)
            if (res.ok) {
              // Continue to success path below.
            } else {
              errBody = await readExportErrorBody(res)
            }
          }
        }
        if (!res.ok) {
          throwExportError(res, errBody)
        }
      }
      const json = exportResponseSchema.parse(await res.json())
      // Best-effort attach the PNG as base64 so MCP can return it as ImageContent.
      // Stat first and skip the read entirely once the file exceeds the cap —
      // a 16 MiB PNG would otherwise allocate ~22 MiB transient strings before
      // we even know we have to drop it. If the file cannot be read (for
      // example it was already removed), return only filePath and let higher
      // layers omit the image block.
      let imageBase64: string | undefined
      try {
        const cap = resolveMaxBase64Bytes()
        const info = await stat(json.filePath)
        if (info.size <= cap) {
          const bytes = await readFile(json.filePath)
          imageBase64 = bytes.toString('base64')
        }
      } catch {
        imageBase64 = undefined
      }
      return imageBase64 !== undefined
        ? { filePath: json.filePath, imageBase64 }
        : { filePath: json.filePath }
    },
  }
}
