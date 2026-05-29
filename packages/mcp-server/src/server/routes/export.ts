import { Hono } from 'hono'
import { join, dirname } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import {
  type ExportErrorBody,
  type ExportResponse,
  exportRequestSchema,
} from '../../shared/api-contracts/export.js'
import { DATA_DIR } from '../config.js'
import { OutputPathError, validateOutputPath } from '../output-path.js'
import { sendExportRequest, getClientCount } from './ws.js'
import { validationErrorBody, validateWorkspaceId, validateSlug } from '../validators.js'
import { toCanvasOutputPathErrorBody } from './canvas-output-path-error.js'

// requestId -> { resolve, reject }
const pendingExports = new Map<
  string,
  { resolve: (data: string) => void; reject: (err: Error) => void }
>()

// Receives WS export_response messages from ws.ts.
export function resolveExportRequest(requestId: string, base64Data: string): void {
  pendingExports.get(requestId)?.resolve(base64Data)
}

export interface CreateExportRouterOptions {
  // Allow tests to override this with a shorter timeout. Default: 10 seconds.
  timeoutMs?: number
}

export function createExportRouter(options: CreateExportRouterOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000
  const app = new Hono()

  // POST /api/canvas/:workspaceId/:slug/export
  app.post('/api/canvas/:workspaceId/:slug/export', async (c) => {
    const { workspaceId, slug } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }

    // The body is optional. Forward { padding?, scale?, minFontPx?, frameId? }
    // to the browser. Empty body is fine; malformed JSON or schema-invalid
    // payloads are rejected with 400 instead of being silently dropped.
    const rawText = await c.req.text()
    let body: z.infer<typeof exportRequestSchema> = {}
    if (rawText.length > 0) {
      let json: unknown
      try {
        json = JSON.parse(rawText)
      } catch {
        const errBody: ExportErrorBody = { error: 'invalid_request', message: 'malformed JSON' }
        return c.json(errBody, 400)
      }
      const parsed = exportRequestSchema.safeParse(json)
      if (!parsed.success) {
        const errBody: ExportErrorBody = {
          error: 'invalid_request',
          message: 'invalid export options',
        }
        return c.json(errBody, 400)
      }
      body = parsed.data
    }
    const options: Pick<typeof body, 'padding' | 'scale' | 'minFontPx' | 'frameId'> = {}
    if (body.padding !== undefined) options.padding = body.padding
    if (body.scale !== undefined) options.scale = body.scale
    if (body.minFontPx !== undefined) options.minFontPx = body.minFontPx
    if (body.frameId !== undefined) options.frameId = body.frameId
    const hasOptions = Object.keys(options).length > 0

    // Validate outputPath up front, before contacting the browser. Reject
    // relative paths and pre-existing files (unless overwrite=true) so the
    // caller does not waste a browser round-trip on a write that will fail.
    let outputPath: string | undefined
    if (typeof body.outputPath === 'string' && body.outputPath.length > 0) {
      try {
        await validateOutputPath(body.outputPath, body.overwrite === true, join(DATA_DIR, workspaceId, 'exports'))
      } catch (err) {
        if (err instanceof OutputPathError) {
          const { status, body: errBody } = toCanvasOutputPathErrorBody(err)
          return c.json(errBody as ExportErrorBody, status)
        }
        throw err
      }
      outputPath = body.outputPath
    }

    // Fast-fail with 503 if no WS client is connected.
    // Do not wait for the timeout because that would not fix a missing client; report
    // the real cause immediately so the caller can open the canvas in a browser first.
    if (getClientCount(workspaceId, slug) === 0) {
      const noClient: ExportErrorBody = {
        error: 'no_client',
        message:
          'No browser client is connected to this canvas. Open the canvas in a browser and retry.',
        hint: 'Call canvas_open first to open the canvas in a browser, then run export_png.',
      }
      return c.json(noClient, 503)
    }

    const requestId = nanoid()

    try {
      const base64Data = await new Promise<string>((resolve, reject) => {
        pendingExports.set(requestId, { resolve, reject })
        sendExportRequest(workspaceId, slug, requestId, hasOptions ? options : undefined)

        setTimeout(() => {
          if (pendingExports.has(requestId)) {
            pendingExports.delete(requestId)
            reject(new Error('timeout'))
          }
        }, timeoutMs)
      }).finally(() => {
        pendingExports.delete(requestId)
      })

      const buffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64')
      let filePath: string
      if (outputPath !== undefined) {
        filePath = outputPath
      } else {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        // .excalidraw.png is a PNG with embedded scene JSON. Normal image viewers treat
        // it as a PNG, and dropping it into Excalidraw restores the scene for editing.
        const fileName = `${slug}-${timestamp}.excalidraw.png`
        const exportsDir = join(DATA_DIR, workspaceId, 'exports')
        filePath = join(exportsDir, fileName)
      }
      // If slug contains "/" (nested canvas paths) or outputPath points into a
      // non-existent directory, create the parents recursively to avoid ENOENT.
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, buffer)

      const response: ExportResponse = { filePath }
      return c.json(response)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === 'timeout') {
        const timeoutBody: ExportErrorBody = {
          error: 'timeout',
          message: `Export timed out after ${Math.round(timeoutMs / 1000)}s. The browser client did not respond.`,
        }
        return c.json(timeoutBody, 504)
      }
      const internalBody: ExportErrorBody = { error: 'internal', message }
      return c.json(internalBody, 500)
    }
  })

  return app
}
