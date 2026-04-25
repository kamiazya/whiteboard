import { readFile } from 'node:fs/promises'
import type { DaemonClient } from '../daemon-client.js'
import { parseCanvasId } from './canvas-id.js'

// Browser cold starts can take 1-3s locally and 4-5s in CI or remote setups,
// so export_png waits 5s instead of 3s to reduce flaky no_client failures.
const EXPORT_PNG_WAIT_TIMEOUT_MS = 5_000
const EXPORT_PNG_WAIT_INTERVAL_MS = 100

interface ExportPngArgs {
  canvasId: string
  padding?: number
  scale?: number
  minFontPx?: number
  frameId?: string
}

interface ExportErrorBody {
  error?: string
  message?: string
  hint?: string
}

function buildExportBody(args: ExportPngArgs): Record<string, number | string> {
  const body: Record<string, number | string> = {}
  if (args.padding !== undefined) body.padding = args.padding
  if (args.scale !== undefined) body.scale = args.scale
  if (args.minFontPx !== undefined) body.minFontPx = args.minFontPx
  if (args.frameId !== undefined) body.frameId = args.frameId
  return body
}

async function requestExport(
  client: DaemonClient,
  sessionId: string,
  slug: string,
  body: Record<string, number | string>,
): Promise<Response> {
  return client.request(`/api/canvas/${sessionId}/${encodeURIComponent(slug)}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function readExportErrorBody(res: Response): Promise<ExportErrorBody | null> {
  return (await res.json().catch(() => null)) as ExportErrorBody | null
}

async function waitForClientReady(
  client: DaemonClient,
  sessionId: string,
  slug: string,
  timeoutMs: number = EXPORT_PNG_WAIT_TIMEOUT_MS,
): Promise<boolean> {
  const statusPath = `/api/canvas/${sessionId}/${encodeURIComponent(slug)}/client-count`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await client.request(statusPath)
      if (res.ok) {
        const body = (await res.json()) as { count: number; readyCount?: number }
        if ((body.readyCount ?? body.count) > 0) return true
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
  throw new Error(`Export failed: ${res.status} ${body?.message ?? 'unknown error'}`)
}

export function exportPngTool() {
  return {
    name: 'export_png',
    description: 'Export the whiteboard canvas as a PNG file',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
        padding: {
          type: 'number',
          description:
            'Padding in pixels around all elements in the exported PNG. Default: 10. Use larger values (e.g., 24-48) to avoid cropping annotation strokes/text.',
        },
        scale: {
          type: 'number',
          description:
            'Export scale factor (appState.exportScale). Default: 1. Use 2-3 for high-DPI exports.',
        },
        minFontPx: {
          type: 'number',
          description:
            'Minimum font size (px) enforced on text-bearing elements before export. Clones elements with Math.max(fontSize, minFontPx) so small annotation text remains legible at small scales.',
        },
        frameId: {
          type: 'string',
          description:
            'When set, export only the elements inside the given frame (plus the frame itself). Useful for section-scoped exports on large canvases to keep the resulting PNG small.',
        },
      },
      required: ['canvasId'],
    },
    execute: async (
      args: ExportPngArgs,
      client: DaemonClient,
    ) => {
      const { sessionId, slug } = parseCanvasId(args.canvasId)
      const body = buildExportBody(args)
      let res = await requestExport(client, sessionId, slug, body)
      if (!res.ok) {
        let errBody = await readExportErrorBody(res)
        if (errBody?.error === 'no_client') {
          const ready = await waitForClientReady(client, sessionId, slug)
          if (ready) {
            res = await requestExport(client, sessionId, slug, body)
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
      const json = (await res.json()) as { filePath: string }
      // Best-effort attach the PNG as base64 so MCP can return it as ImageContent.
      // If the file cannot be read (for example it was already removed), return
      // only filePath and let higher layers omit the image block.
      let imageBase64: string | undefined
      try {
        const bytes = await readFile(json.filePath)
        imageBase64 = bytes.toString('base64')
      } catch {
        imageBase64 = undefined
      }
      return imageBase64 !== undefined
        ? { filePath: json.filePath, imageBase64 }
        : { filePath: json.filePath }
    },
  }
}
