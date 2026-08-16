import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { nanoid } from 'nanoid'
import type { ExportErrorBody } from '../../../shared/api-contracts/export.js'
import {
  type ExportSvgRequest,
  exportSvgRequestSchema,
} from '../../../shared/api-contracts/export-svg.js'
import { getDataDir } from '../../config.js'
import { exportCanvasHeadlessSvg } from '../../export/headless-export.js'
import { OutputPathError, validateOutputPath } from '../../output-path.js'
import { toCanvasOutputPathErrorBody } from '../canvas-output-path-error.js'
import { onCanvasAction } from './path-route.js'

// The body is a small JSON options object (padding/frameId/theme/outputPath),
// never canvas content — the export itself is rendered server-side from the
// persisted doc. 1 MiB is a generous ceiling for that shape while still
// bounding an adversarial request.
const EXPORT_OPTIONS_BODY_LIMIT_BYTES = 1024 * 1024

// POST /api/w/:workspaceId/canvas/<path>/export-svg
//
// Unlike PNG export, this always renders headless straight from the
// persisted LoroDoc — unlike export.ts (PNG, which prefers the browser). SVG
// requests are typically automation / doc-generation use cases, not "match
// what's on the connected browser's screen right now", so there is no WS
// round-trip and no browser-connection requirement to plumb through.
export function createCanvasSvgExportRouter() {
  const app = new Hono()

  onCanvasAction(
    app,
    'post',
    'export-svg',
    async (c, workspaceId, path) => {
      const rawText = await c.req.text()
      let body: ExportSvgRequest = {}
      if (rawText.length > 0) {
        let json: unknown
        try {
          json = JSON.parse(rawText)
        } catch {
          const errBody: ExportErrorBody = { error: 'invalid_request', message: 'malformed JSON' }
          return c.json(errBody, 400)
        }
        const parsed = exportSvgRequestSchema.safeParse(json)
        if (!parsed.success) {
          const errBody: ExportErrorBody = {
            error: 'invalid_request',
            message: 'invalid export options',
          }
          return c.json(errBody, 400)
        }
        body = parsed.data
      }

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

      let svg: string
      try {
        const result = await exportCanvasHeadlessSvg({
          workspaceId,
          // The store layer still speaks `path`; renaming it through
          // headless-export and canvas-store is its own sweep.
          path: path,
          options: { padding: body.padding, frameId: body.frameId, theme: body.theme },
        })
        svg = result.svg
      } catch (err) {
        const errBody: ExportErrorBody = {
          error: 'headless_export_failed',
          message: err instanceof Error ? err.message : String(err),
        }
        return c.json(errBody, 500)
      }

      const filePath = outputPath ?? defaultSvgExportPath(workspaceId, path)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, svg, 'utf-8')
      return c.json({ filePath })
    },
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
  )

  return app
}

function defaultSvgExportPath(workspaceId: string, path: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  // The millisecond timestamp alone is not unique: two exports issued fast
  // enough to land in the same millisecond would collide and the second
  // write would silently clobber the first. The random suffix guarantees
  // uniqueness regardless of call timing, matching the PNG and JSON export
  // routes' default-path convention.
  const fileName = `${path}-${timestamp}-${nanoid(6)}.svg`
  return join(getDataDir(), workspaceId, 'exports', fileName)
}
