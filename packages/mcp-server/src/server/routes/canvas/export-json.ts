import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { exportCanvasJsonRequestSchema } from '../../../shared/api-contracts/canvas.js'
import { exportCanvasJsonDoc, OutputPathError } from '../../export-json.js'
import { getDoc } from '../../store/doc-cache.js'
import { validateSlug, validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { toCanvasOutputPathErrorBody } from '../canvas-output-path-error.js'

// The body is a small JSON options object (includeCustomFields/outputPath),
// never canvas content — export.ts/export-json.ts/export-svg.ts all render
// server-side from the persisted doc rather than accepting client-supplied
// canvas data. 1 MiB is a generous ceiling for that shape while still
// bounding an adversarial request.
const EXPORT_OPTIONS_BODY_LIMIT_BYTES = 1024 * 1024

// POST /api/canvas/:workspaceId/:slug/export-json
export function createCanvasJsonExportRouter() {
  const app = new Hono()

  app.post(
    '/api/canvas/:workspaceId/:slug/export-json',
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
      const rawText = await c.req.text()
      const body =
        rawText.length === 0
          ? exportCanvasJsonRequestSchema.parse({})
          : await (async () => {
              let json: unknown
              try {
                json = JSON.parse(rawText)
              } catch {
                return null
              }
              const parsed = exportCanvasJsonRequestSchema.safeParse(json)
              return parsed.success ? parsed.data : null
            })()
      if (body === null) {
        return c.json({ error: 'invalid_body', message: 'invalid export options' }, 400)
      }
      const includeCustomFields = body.includeCustomFields === true
      const outputPath =
        typeof body.outputPath === 'string' && body.outputPath.length > 0
          ? body.outputPath
          : undefined
      const overwrite = body.overwrite === true
      const doc = await getDoc(workspaceId, slug)
      try {
        return c.json(
          await exportCanvasJsonDoc({
            workspaceId,
            slug,
            doc,
            includeCustomFields,
            outputPath,
            overwrite,
          }),
        )
      } catch (err) {
        if (err instanceof OutputPathError) {
          const { status, body } = toCanvasOutputPathErrorBody(err, workspaceId)
          return c.json(body, status)
        }
        throw err
      }
    },
  )

  return app
}
