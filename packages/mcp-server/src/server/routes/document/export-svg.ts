import { isDatabaseBusy } from '@kamiazya/whiteboard-ports'
import type { ApiErrorBody, LiveDocuments } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import type { ExportResponse } from '../../../shared/api-contracts/export.js'
import {
  type ExportSvgRequest,
  exportSvgRequestSchema,
} from '../../../shared/api-contracts/export-svg.js'
import { exportCanvasHeadlessSvg } from '../../export/headless-export.js'
import { getLogger } from '../../log.js'
import type { StoreScope } from '../../store/store-scope.js'
import {
  documentMissingBody,
  readExportBody,
  resolveRequestedOutputPath,
  writeExportFile,
} from '../export-request.js'
import { onDocumentAction } from './path-route.js'

// POST /api/w/:workspaceId/document/<path>/export-svg
//
// Unlike PNG export, this always renders headless straight from the
// persisted LoroDoc — unlike export.ts (PNG, which prefers the browser). SVG
// requests are typically automation / doc-generation use cases, not "match
// what's on the connected browser's screen right now", so there is no
// browser round-trip and no browser-connection requirement to plumb through.
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
  scope: StoreScope
}

export function createDocumentSvgExportRouter(options: DocumentSvgExportRouterOptions) {
  const app = new Hono()
  const documentExists = async (workspaceId: string, path: string) =>
    options.liveDocuments.exists(workspaceId, path)

  onDocumentAction(app, 'post', 'export-svg', async (c, workspaceId, path) => {
    const parsedBody = await readExportBody(c, exportSvgRequestSchema)
    if ('refusal' in parsedBody) return parsedBody.refusal
    const body: ExportSvgRequest = parsedBody.data

    const { layout } = options.scope
    const resolved = await resolveRequestedOutputPath(body, workspaceId, layout)
    if ('error' in resolved) return c.json(resolved.error, resolved.status)
    const outputPath = resolved.outputPath

    if (!(await documentExists(workspaceId, path))) {
      return c.json(documentMissingBody(workspaceId, path), 404)
    }

    let svg: string
    let undrawable: readonly string[]
    let unresolvedFamilies: readonly string[]
    try {
      const result = await exportCanvasHeadlessSvg({
        workspaceId,
        path,
        scope: options.scope,
        options: { padding: body.padding, theme: body.theme, style: body.style },
      })
      svg = result.svg
      undrawable = result.undrawable
      unresolvedFamilies = result.unresolvedFamilies
    } catch (err) {
      // A busy database is the app's to answer (503 with Retry-After). Any
      // other cause reaches the log only: a renderer's message can carry a
      // path or a statement.
      if (isDatabaseBusy(err)) throw err
      getLogger('export').error({ err, workspaceId, path }, 'headless SVG export failed')
      const errBody: ApiErrorBody = {
        error: 'headless_export_failed',
        message: 'The document could not be rendered to SVG.',
      }
      return c.json(errBody, 500)
    }

    const filePath = await writeExportFile(svg, {
      outputPath,
      layout,
      workspaceId,
      path,
      extension: 'svg',
    })
    // Typed rather than a bare literal so the contract, not this handler,
    // decides what an export answers with — the PNG route and this one had
    // already drifted into two different response shapes.
    const response: ExportResponse = {
      filePath,
      undrawable: [...undrawable],
      unresolvedFamilies: [...unresolvedFamilies],
    }
    return c.json(response)
  })

  return app
}
