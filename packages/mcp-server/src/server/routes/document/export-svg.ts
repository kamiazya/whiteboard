import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { nanoid } from 'nanoid'
import type { ExportErrorBody, ExportResponse } from '../../../shared/api-contracts/export.js'
import {
  type ExportSvgRequest,
  exportSvgRequestSchema,
} from '../../../shared/api-contracts/export-svg.js'
import { getDataDir } from '../../config.js'
import { exportCanvasHeadlessSvg } from '../../export/headless-export.js'
import { OutputPathError, validateOutputPath } from '../../output-path.js'
import { documentExists } from '../../store/document-store.js'
import { toDocumentOutputPathErrorBody } from '../document-output-path-error.js'
import { onDocumentAction } from './path-route.js'

// The body is a small JSON options object (padding/frameId/theme/outputPath),
// never canvas content — the export itself is rendered server-side from the
// persisted doc. 1 MiB is a generous ceiling for that shape while still
// bounding an adversarial request.
const EXPORT_OPTIONS_BODY_LIMIT_BYTES = 1024 * 1024

/**
 * An empty body is a valid export request — every option has a default — so
 * only a body that is PRESENT and unreadable refuses.
 */
function parseExportSvgBody(
  rawText: string,
): { body: ExportSvgRequest } | { error: ExportErrorBody } {
  if (rawText.length === 0) return { body: {} }
  let json: unknown
  try {
    json = JSON.parse(rawText)
  } catch {
    return { error: { error: 'invalid_request', message: 'malformed JSON' } }
  }
  const parsed = exportSvgRequestSchema.safeParse(json)
  if (!parsed.success) {
    return { error: { error: 'invalid_request', message: 'invalid export options' } }
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
): Promise<
  { outputPath: string | undefined } | { error: ExportErrorBody; status: ContentfulStatusCode }
> {
  if (typeof body.outputPath !== 'string' || body.outputPath.length === 0) {
    return { outputPath: undefined }
  }
  try {
    await validateOutputPath(
      body.outputPath,
      body.overwrite === true,
      join(getDataDir(), workspaceId, 'exports'),
    )
  } catch (err) {
    if (err instanceof OutputPathError) {
      const { status, body: errBody } = toDocumentOutputPathErrorBody(err, workspaceId)
      return { error: errBody as ExportErrorBody, status }
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
export function createDocumentSvgExportRouter() {
  const app = new Hono()

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
        const errBody: ExportErrorBody = {
          error: 'canvas_not_found',
          message: `Canvas not found: ${workspaceId}/${path}`,
        }
        return c.json(errBody, 404)
      }

      const parsedBody = parseExportSvgBody(await c.req.text())
      if ('error' in parsedBody) return c.json(parsedBody.error, 400)
      const body = parsedBody.body

      const resolved = await resolveSvgOutputPath(body, workspaceId)
      if ('error' in resolved) return c.json(resolved.error as ExportErrorBody, resolved.status)
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
            frameId: body.frameId,
            theme: body.theme,
            style: body.style,
          },
        })
        svg = result.svg
        undrawable = result.undrawable
        unresolvedFamilies = result.unresolvedFamilies
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
