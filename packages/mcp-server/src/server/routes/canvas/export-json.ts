import { Hono } from 'hono'
import { exportCanvasJsonRequestSchema } from '../../../shared/api-contracts/canvas.js'
import { exportCanvasJsonDoc, OutputPathError } from '../../export-json.js'
import { getDoc } from '../../store/doc-cache.js'
import { validateSlug, validateWorkspaceId, validationErrorBody } from '../../validators.js'
import { toCanvasOutputPathErrorBody } from '../canvas-output-path-error.js'

// POST /api/canvas/:workspaceId/:slug/export-json
export function createCanvasJsonExportRouter() {
  const app = new Hono()

  app.post('/api/canvas/:workspaceId/:slug/export-json', async (c) => {
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
  })

  return app
}
