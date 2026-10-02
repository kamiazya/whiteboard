import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { messageOf } from '@kamiazya/whiteboard-model'
import {
  type ApiErrorBody,
  invalidRequestBody,
  type LiveDocuments,
} from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { nanoid } from 'nanoid'
import type { ExportResponse } from '../../../shared/api-contracts/export.js'
import {
  type ExportSvgRequest,
  exportSvgRequestSchema,
} from '../../../shared/api-contracts/export-svg.js'
import { exportCanvasHeadlessSvg } from '../../export/headless-export.js'
import { OutputPathError, validateOutputPath } from '../../output-path.js'
import type { DataLayout } from '../../tenant/data-layout-seam.js'
import { EXPORT_OPTIONS_BODY_LIMIT_BYTES, limitBody } from '../body-limit.js'
import { toDocumentOutputPathErrorBody } from '../document-output-path-error.js'
import { onDocumentAction } from './path-route.js'

/**
 * An empty body is a valid export request — every option has a default — so
 * only a body that is PRESENT and unreadable refuses.
 */
function parseExportSvgBody(rawText: string): { body: ExportSvgRequest } | { error: ApiErrorBody } {
  if (rawText.length === 0) return { body: {} }
  let json: unknown
  try {
    json = JSON.parse(rawText)
  } catch {
    return { error: { error: 'invalid_request', message: 'malformed JSON' } }
  }
  const parsed = exportSvgRequestSchema.safeParse(json)
  if (!parsed.success) {
    return { error: invalidRequestBody(parsed.error) }
  }
  return { body: parsed.data }
}

/**
 * `undefined` means "the caller named no path", which is not a refusal — the
 * handler then writes to `defaultSvgExportPath`. A path that IS named is
 * validated against the workspace's own exports directory, and anything
 * `validateOutputPath` refuses becomes this route's error shape.
 */
async function resolveSvgOutputPath(
  body: ExportSvgRequest,
  workspaceId: string,
  exportsDir: string,
): Promise<
  { outputPath: string | undefined } | { error: ApiErrorBody; status: ContentfulStatusCode }
> {
  if (typeof body.outputPath !== 'string' || body.outputPath.length === 0) {
    return { outputPath: undefined }
  }
  try {
    await validateOutputPath(body.outputPath, body.overwrite === true, exportsDir)
  } catch (err) {
    if (err instanceof OutputPathError) {
      const { status, body: errBody } = toDocumentOutputPathErrorBody(err, workspaceId)
      return { error: errBody, status }
    }
    throw err
  }
  return { outputPath: body.outputPath }
}

// POST /api/w/:workspaceId/document/<path>/export-svg
//
// Unlike PNG export, this always renders headless straight from the
// persisted LoroDoc — unlike export.ts (PNG, which prefers the browser). SVG
// requests are typically automation / doc-generation use cases, not "match
// what's on the connected browser's screen right now", so there is no WS
// round-trip and no browser-connection requirement to plumb through.
/**
 * The SVG route's `exists`, like the PNG route's in `routes/export.ts`, is asked of the LiveDocuments seam rather than the store
 * (ADR-0018: an adapter translates, it does not reach a mechanic). The
 * daemon passes its own; a router built without one — a route test, an
 * ad-hoc caller — falls back to the same production wiring.
 *
 * Default exports are written under the layout's exports directory, which
 * the composition root hands down with the deps it booted.
 */
export interface DocumentSvgExportRouterOptions {
  liveDocuments: Pick<LiveDocuments, 'exists'>
  dataLayout: DataLayout
}

export function createDocumentSvgExportRouter(options: DocumentSvgExportRouterOptions) {
  const app = new Hono()
  const documentExists = async (workspaceId: string, path: string) =>
    options.liveDocuments.exists(workspaceId, path)

  onDocumentAction(
    app,
    'post',
    'export-svg',
    async (c, workspaceId, path) => {
      // The same guard the PNG route carries, and for the same reason: the
      // headless path answers a missing document with an EMPTY one, so a
      // typoed path would otherwise return 200 and a valid-looking SVG of
      // nothing. Its absence here was the asymmetry, not a decision.
      if (!(await documentExists(workspaceId, path))) {
        const errBody: ApiErrorBody = {
          error: 'not_found',
          message: `Canvas not found: ${workspaceId}/${path}`,
        }
        return c.json(errBody, 404)
      }

      const parsedBody = parseExportSvgBody(await c.req.text())
      if ('error' in parsedBody) return c.json(parsedBody.error, 400)
      const body = parsedBody.body

      const exportsDir = options.dataLayout.exportsDir(workspaceId)
      const resolved = await resolveSvgOutputPath(body, workspaceId, exportsDir)
      if ('error' in resolved) return c.json(resolved.error, resolved.status)
      const outputPath = resolved.outputPath

      let svg: string
      let undrawable: readonly string[]
      let unresolvedFamilies: readonly string[]
      try {
        const result = await exportCanvasHeadlessSvg({
          workspaceId,
          path,
          options: {
            padding: body.padding,
            theme: body.theme,
            style: body.style,
          },
        })
        svg = result.svg
        undrawable = result.undrawable
        unresolvedFamilies = result.unresolvedFamilies
      } catch (err) {
        const errBody: ApiErrorBody = {
          error: 'headless_export_failed',
          message: messageOf(err),
        }
        return c.json(errBody, 500)
      }

      const filePath = outputPath ?? defaultSvgExportPath(exportsDir, path)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, svg, 'utf-8')
      // Typed rather than a bare literal so the contract, not this handler,
      // decides what an export answers with — the PNG route and this one had
      // already drifted into two different response shapes.
      const response: ExportResponse = {
        filePath,
        undrawable: [...undrawable],
        unresolvedFamilies: [...unresolvedFamilies],
      }
      return c.json(response)
    },
    limitBody(EXPORT_OPTIONS_BODY_LIMIT_BYTES, 'Request body'),
  )

  return app
}

function defaultSvgExportPath(exportsDir: string, path: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  // The millisecond timestamp alone is not unique: two exports issued fast
  // enough to land in the same millisecond would collide and the second
  // write would silently clobber the first. The random suffix guarantees
  // uniqueness regardless of call timing, matching the PNG and JSON export
  // routes' default-path convention.
  const fileName = `${path}-${timestamp}-${nanoid(6)}.svg`
  return join(exportsDir, fileName)
}
