import { Hono } from 'hono'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { exportSvgRequestSchema } from '../../../shared/api-contracts/export-svg.js'
import type { ExportErrorBody } from '../../../shared/api-contracts/export.js'
import { DATA_DIR } from '../../config.js'
import { exportCanvasHeadlessSvg } from '../../export/headless-export.js'
import { OutputPathError, validateOutputPath } from '../../output-path.js'
import { validationErrorBody, validateWorkspaceId, validateSlug } from '../../validators.js'
import { toCanvasOutputPathErrorBody } from '../canvas-output-path-error.js'

// POST /api/canvas/:workspaceId/:slug/export-svg
//
// Unlike PNG export, this always renders headless straight from the
// persisted LoroDoc — mirroring export-json.ts rather than export.ts. SVG
// requests are typically automation / doc-generation use cases, not "match
// what's on the connected browser's screen right now", so there is no WS
// round-trip and no browser-connection requirement to plumb through.
export function createCanvasSvgExportRouter() {
  const app = new Hono()

  app.post('/api/canvas/:workspaceId/:slug/export-svg', async (c) => {
    const { workspaceId, slug } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }

    const rawText = await c.req.text()
    let body: ReturnType<typeof exportSvgRequestSchema.parse> = {}
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
          join(DATA_DIR, workspaceId, 'exports'),
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
        slug,
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

    const filePath = outputPath ?? defaultSvgExportPath(workspaceId, slug)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, svg, 'utf-8')
    return c.json({ filePath })
  })

  return app
}

function defaultSvgExportPath(workspaceId: string, slug: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const fileName = `${slug}-${timestamp}.svg`
  return join(DATA_DIR, workspaceId, 'exports', fileName)
}
