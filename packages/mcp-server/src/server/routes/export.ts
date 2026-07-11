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
import { exportCanvasHeadless } from '../export/headless-export.js'
import { OutputPathError, validateOutputPath } from '../output-path.js'
import { canvasExists } from '../store/canvas-store.js'
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
    const options: Pick<typeof body, 'padding' | 'scale' | 'minFontPx' | 'frameId' | 'theme'> = {}
    if (body.padding !== undefined) options.padding = body.padding
    if (body.scale !== undefined) options.scale = body.scale
    if (body.minFontPx !== undefined) options.minFontPx = body.minFontPx
    if (body.frameId !== undefined) options.frameId = body.frameId
    if (body.theme !== undefined) options.theme = body.theme
    const hasOptions = Object.keys(options).length > 0

    // Validate outputPath up front, before contacting the browser. Reject
    // relative paths and pre-existing files (unless overwrite=true) so the
    // caller does not waste a browser round-trip on a write that will fail.
    let outputPath: string | undefined
    if (typeof body.outputPath === 'string' && body.outputPath.length > 0) {
      try {
        await validateOutputPath(
          body.outputPath,
          body.overwrite === true,
          join(DATA_DIR, workspaceId, 'exports'),
        )
      } catch (err) {
        if (err instanceof OutputPathError) {
          const { status, body: errBody } = toCanvasOutputPathErrorBody(err)
          return c.json(errBody as ExportErrorBody, status)
        }
        throw err
      }
      outputPath = body.outputPath
    }

    // Two PNG production paths share the same input validation and the same
    // disk-write step; they only differ in where the bytes come from.
    //   • browser path:  send a request over WS and wait for a base64 reply
    //   • headless path: render directly from the LoroDoc using @resvg
    // The browser path is preferred when a client is connected because it
    // matches what the user is currently looking at (zoom, selection, etc.).
    // The headless path operates directly on the LoroDoc and does NOT verify
    // that the canvas actually exists — getDoc / loadCanvas return an empty
    // doc on cache miss, so a typoed slug would otherwise emit a blank PNG.
    // Reject up front with 404 so callers learn about the typo instead of
    // shipping the silently-empty file.
    const useHeadless = getClientCount(workspaceId, slug) === 0
    if (useHeadless && !(await canvasExists(workspaceId, slug))) {
      const errBody: ExportErrorBody = {
        error: 'canvas_not_found',
        message: `Canvas not found: ${workspaceId}/${slug}`,
      }
      return c.json(errBody, 404)
    }

    let pngBuffer: Buffer
    try {
      pngBuffer = await (useHeadless
        ? renderHeadless(workspaceId, slug, body)
        : renderViaBrowser(workspaceId, slug, options, hasOptions, timeoutMs))
    } catch (err) {
      // Browser path failure where the WS clients have all disconnected
      // since the count check is recoverable: the headless path can
      // still produce a PNG. Re-sample the count and only fall back if
      // the canvas exists, so a typo still surfaces as canvas_not_found
      // instead of silently rendering blank bytes.
      if (
        !useHeadless &&
        getClientCount(workspaceId, slug) === 0 &&
        (await canvasExists(workspaceId, slug))
      ) {
        try {
          pngBuffer = await renderHeadless(workspaceId, slug, body)
        } catch (headlessErr) {
          return c.json(toErrorBody(headlessErr, timeoutMs), errorStatus(headlessErr))
        }
      } else {
        return c.json(toErrorBody(err, timeoutMs), errorStatus(err))
      }
    }

    const filePath = outputPath ?? defaultExportPath(workspaceId, slug)
    // Slug may contain "/" or outputPath may point into a missing directory.
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, pngBuffer)
    const response: ExportResponse = { filePath }
    return c.json(response)
  })

  return app

  // --- helpers --------------------------------------------------------------

  async function renderHeadless(
    workspaceId: string,
    slug: string,
    body: z.infer<typeof exportRequestSchema>,
  ): Promise<Buffer> {
    try {
      const result = await exportCanvasHeadless({
        workspaceId,
        slug,
        options: {
          padding: body.padding,
          scale: body.scale,
          frameId: body.frameId,
          minFontPx: body.minFontPx,
          theme: body.theme,
        },
      })
      return result.png
    } catch (err) {
      throw new ExportError('headless_export_failed', err)
    }
  }

  async function renderViaBrowser(
    workspaceId: string,
    slug: string,
    options: Pick<
      z.infer<typeof exportRequestSchema>,
      'padding' | 'scale' | 'minFontPx' | 'frameId' | 'theme'
    >,
    hasOptions: boolean,
    timeoutMs: number,
  ): Promise<Buffer> {
    const requestId = nanoid()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const base64Data = await new Promise<string>((resolve, reject) => {
        pendingExports.set(requestId, { resolve, reject })
        sendExportRequest(workspaceId, slug, requestId, hasOptions ? options : undefined)
        timer = setTimeout(() => {
          if (pendingExports.has(requestId)) {
            pendingExports.delete(requestId)
            reject(new Error('timeout'))
          }
        }, timeoutMs)
      }).finally(() => {
        pendingExports.delete(requestId)
        clearTimeout(timer)
      })
      return Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64')
    } catch (err) {
      throw new ExportError('browser_export_failed', err)
    }
  }
}

function defaultExportPath(workspaceId: string, slug: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  // .excalidraw.png is a PNG with embedded scene JSON. Normal image viewers
  // treat it as a PNG, and dropping it into Excalidraw restores the scene.
  const fileName = `${slug}-${timestamp}.excalidraw.png`
  return join(DATA_DIR, workspaceId, 'exports', fileName)
}

class ExportError extends Error {
  constructor(
    public readonly kind: 'browser_export_failed' | 'headless_export_failed',
    cause: unknown,
  ) {
    const inner = cause instanceof Error ? cause.message : String(cause)
    super(inner)
    this.name = 'ExportError'
  }
}

function toErrorBody(err: unknown, timeoutMs: number): ExportErrorBody {
  if (err instanceof ExportError) {
    if (err.kind === 'browser_export_failed' && err.message === 'timeout') {
      return {
        error: 'timeout',
        message: `Export timed out after ${Math.round(timeoutMs / 1000)}s. The browser client did not respond.`,
      }
    }
    return { error: err.kind, message: err.message }
  }
  return { error: 'internal', message: err instanceof Error ? err.message : String(err) }
}

function errorStatus(err: unknown): 500 | 504 {
  if (
    err instanceof ExportError &&
    err.kind === 'browser_export_failed' &&
    err.message === 'timeout'
  ) {
    return 504
  }
  return 500
}
