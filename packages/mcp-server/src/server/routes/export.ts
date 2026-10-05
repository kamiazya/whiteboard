import { messageOf } from '@kamiazya/whiteboard-model'
import { isDatabaseBusy } from '@kamiazya/whiteboard-ports'
import type { ApiErrorBody, LiveDocuments } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { z } from 'zod'
import { type ExportResponse, exportRequestSchema } from '../../shared/api-contracts/export.js'
import { exportCanvasHeadless } from '../export/headless-export.js'
import { getLogger } from '../log.js'
import type { StoreScope } from '../store/store-scope.js'
import { onDocumentAction } from './document/path-route.js'
import {
  documentMissingBody,
  readExportBody,
  resolveRequestedOutputPath,
  writeExportFile,
} from './export-request.js'

/**
 * The render, with the one failure that belongs to the REQUEST rather than
 * to the renderer separated out: a positive scale can still size the target
 * below one pixel, and the size came from the caller — so that is a 400,
 * a busy database is left to the app's 503, and everything else here is a 500.
 */
async function renderedExport(
  workspaceId: string,
  path: string,
  body: z.infer<typeof exportRequestSchema>,
  scope: StoreScope,
): Promise<
  Awaited<ReturnType<typeof renderHeadless>> | { error: ApiErrorBody; status: ContentfulStatusCode }
> {
  try {
    return await renderHeadless(workspaceId, path, body, scope)
  } catch (err) {
    const message = messageOf(err)
    if (/target size is zero/i.test(message)) {
      return {
        error: { error: 'invalid_request', message: `invalid export options: ${message}` },
        status: 400,
      }
    }
    if (isDatabaseBusy(err)) throw err
    // The renderer's message can carry a path or a statement: it goes to the
    // log, never the body.
    getLogger('export').error({ err, workspaceId, path }, 'headless PNG export failed')
    return {
      error: { error: 'headless_export_failed', message: 'The document could not be exported.' },
      status: 500,
    }
  }
}

/**
 * `exists` is asked of the LiveDocuments seam rather than the store
 * (ADR-0018: an adapter translates, it does not reach a mechanic). The
 * daemon passes its own; a router built without one — a route test, an
 * ad-hoc caller — falls back to the same production wiring.
 *
 * Default exports are written under the scope's exports directory, which
 * the composition root hands down with the deps it booted — and the document
 * rendered is read from that same directory.
 */
export interface ExportRouterOptions {
  liveDocuments: Pick<LiveDocuments, 'exists'>
  scope: StoreScope
}

export function createExportRouter(options: ExportRouterOptions) {
  const app = new Hono()
  const documentExists = async (workspaceId: string, path: string) =>
    options.liveDocuments.exists(workspaceId, path)

  // POST /api/w/:workspaceId/document/<path>/export
  onDocumentAction(app, 'post', 'export', async (c, workspaceId, path) => {
    const parsedBody = await readExportBody(c, exportRequestSchema)
    if ('refusal' in parsedBody) return parsedBody.refusal
    const body = parsedBody.data

    // Validated up front, before rendering, so the caller does not waste a
    // render on a write that will fail.
    const { layout } = options.scope
    const resolved = await resolveRequestedOutputPath(body, workspaceId, layout)
    if ('error' in resolved) return c.json(resolved.error, resolved.status)
    const outputPath = resolved.outputPath

    // The headless path operates directly on the LoroDoc and does NOT
    // verify that the canvas actually exists — getDoc / loadDocument return
    // an empty doc on cache miss, so a typoed path would otherwise emit a
    // blank PNG. Reject up front with 404 so callers learn about the typo
    // instead of shipping the silently-empty file.
    if (!(await documentExists(workspaceId, path))) {
      return c.json(documentMissingBody(workspaceId, path), 404)
    }

    const rendered = await renderedExport(workspaceId, path, body, options.scope)
    if ('error' in rendered) return c.json(rendered.error, rendered.status)
    const { png: pngBuffer, undrawable, unresolvedFamilies } = rendered

    const filePath = await writeExportFile(pngBuffer, {
      outputPath,
      layout,
      workspaceId,
      path,
      extension: 'png',
    })
    const response: ExportResponse = {
      filePath,
      undrawable: [...undrawable],
      unresolvedFamilies: [...unresolvedFamilies],
    }
    return c.json(response)
  })

  return app
}

async function renderHeadless(
  workspaceId: string,
  path: string,
  body: z.infer<typeof exportRequestSchema>,
  scope: StoreScope,
): Promise<{
  png: Buffer
  undrawable: readonly string[]
  unresolvedFamilies: readonly string[]
}> {
  const result = await exportCanvasHeadless({
    workspaceId,
    path,
    scope,
    options: {
      padding: body.padding,
      scale: body.scale,
      theme: body.theme,
      style: body.style,
    },
  })
  return {
    png: result.png,
    undrawable: result.undrawable,
    unresolvedFamilies: result.unresolvedFamilies,
  }
}
