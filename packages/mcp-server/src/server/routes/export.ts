import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { nanoid } from 'nanoid'
import type { z } from 'zod'
import {
  type ExportErrorBody,
  type ExportResponse,
  exportRequestSchema,
} from '../../shared/api-contracts/export.js'
import { getDataDir } from '../config.js'
import { exportCanvasHeadless } from '../export/headless-export.js'
import { OutputPathError, validateOutputPath } from '../output-path.js'
import { canvasExists } from '../store/canvas-store.js'
import { validateSlug, validateWorkspaceId, validationErrorBody } from '../validators.js'
import { toCanvasOutputPathErrorBody } from './canvas-output-path-error.js'

// The body is a small JSON options object (padding/scale/frameId/theme/
// outputPath), never canvas content — the PNG is always rendered headlessly
// from the persisted document. 1 MiB is a generous ceiling for that shape
// while still bounding an adversarial request.
const EXPORT_OPTIONS_BODY_LIMIT_BYTES = 1024 * 1024

export function createExportRouter() {
  const app = new Hono()

  // POST /api/canvas/:workspaceId/:slug/export
  app.post(
    '/api/canvas/:workspaceId/:slug/export',
    bodyLimit({
      maxSize: EXPORT_OPTIONS_BODY_LIMIT_BYTES,
      onError: (c) =>
        c.json(
          {
            error: 'payload_too_large',
            message: `Request body exceeds ${EXPORT_OPTIONS_BODY_LIMIT_BYTES} bytes limit.`,
          },
          413,
        ),
    }),
    async (c) => {
      const { workspaceId, slug } = c.req.param()
      try {
        validateWorkspaceId(workspaceId)
        validateSlug(slug)
      } catch (err) {
        const body = validationErrorBody(err)
        if (body) return c.json(body, 400)
        throw err
      }

      // The body is optional. Empty body is fine; malformed JSON or
      // schema-invalid payloads are rejected with 400 instead of being
      // silently dropped.
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

      // Validate outputPath up front, before rendering. Reject relative
      // paths and pre-existing files (unless overwrite=true) so the caller
      // does not waste a render on a write that will fail.
      let outputPath: string | undefined
      if (typeof body.outputPath === 'string' && body.outputPath.length > 0) {
        try {
          await validateOutputPath(
            body.outputPath,
            body.overwrite === true,
            join(getDataDir(), workspaceId, 'exports'),
          )
        } catch (err) {
          if (err instanceof OutputPathError) {
            const { status, body: errBody } = toCanvasOutputPathErrorBody(err, workspaceId)
            return c.json(errBody as ExportErrorBody, status)
          }
          throw err
        }
        outputPath = body.outputPath
      }

      // The headless path operates directly on the LoroDoc and does NOT
      // verify that the canvas actually exists — getDoc / loadCanvas return
      // an empty doc on cache miss, so a typoed slug would otherwise emit a
      // blank PNG. Reject up front with 404 so callers learn about the typo
      // instead of shipping the silently-empty file.
      if (!(await canvasExists(workspaceId, slug))) {
        const errBody: ExportErrorBody = {
          error: 'canvas_not_found',
          message: `Canvas not found: ${workspaceId}/${slug}`,
        }
        return c.json(errBody, 404)
      }

      let pngBuffer: Buffer
      try {
        pngBuffer = await renderHeadless(workspaceId, slug, body)
      } catch (err) {
        return c.json(toErrorBody(err), errorStatus(err))
      }

      const filePath = outputPath ?? defaultExportPath(workspaceId, slug)
      // Slug may contain "/" or outputPath may point into a missing directory.
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, pngBuffer)
      const response: ExportResponse = { filePath }
      return c.json(response)
    },
  )

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
}

function defaultExportPath(workspaceId: string, slug: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  // .excalidraw.png is a PNG with embedded scene JSON. Normal image viewers
  // treat it as a PNG, and dropping it into Excalidraw restores the scene.
  // The millisecond timestamp alone is not unique: two exports issued fast
  // enough to land in the same millisecond would collide and the second
  // write would silently clobber the first. The random suffix guarantees
  // uniqueness regardless of call timing.
  const fileName = `${slug}-${timestamp}-${nanoid(6)}.excalidraw.png`
  return join(getDataDir(), workspaceId, 'exports', fileName)
}

class ExportError extends Error {
  constructor(
    public readonly kind: 'headless_export_failed',
    cause: unknown,
  ) {
    const inner = cause instanceof Error ? cause.message : String(cause)
    super(inner)
    this.name = 'ExportError'
  }
}

function toErrorBody(err: unknown): ExportErrorBody {
  if (err instanceof ExportError) {
    return { error: err.kind, message: err.message }
  }
  return { error: 'internal', message: err instanceof Error ? err.message : String(err) }
}

function errorStatus(_err: unknown): 500 {
  return 500
}
