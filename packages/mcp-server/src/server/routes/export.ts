import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { messageOf } from '@kamiazya/whiteboard-model'
import type { ApiErrorBody, LiveDocuments } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { z } from 'zod'
import { type ExportResponse, exportRequestSchema } from '../../shared/api-contracts/export.js'
import { isErrnoCode } from '../../shared/errno.js'
import { exportCanvasHeadless } from '../export/headless-export.js'
import type { StoreScope } from '../store/store-scope.js'
import type { DataLayout } from '../tenant/data-layout-seam.js'
import { EXPORT_OPTIONS_BODY_LIMIT_BYTES, limitBody } from './body-limit.js'
import { onDocumentAction } from './document/path-route.js'
import {
  defaultExportPath,
  documentMissingBody,
  parseExportBody,
  resolveRequestedOutputPath,
} from './export-request.js'

/**
 * The render, with the one failure that belongs to the REQUEST rather than
 * to the renderer separated out: a positive scale can still size the target
 * below one pixel, and the size came from the caller — so that is a 400,
 * while everything else here is a 500.
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
    return { error: { error: 'headless_export_failed', message }, status: 500 }
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
  onDocumentAction(
    app,
    'post',
    'export',
    async (c, workspaceId, path) => {
      const parsedBody = parseExportBody(await c.req.text(), exportRequestSchema)
      if ('error' in parsedBody) return c.json(parsedBody.error, 400)
      const body = parsedBody.body

      // Validated up front, before rendering, so the caller does not waste a
      // render on a write that will fail.
      const resolved = await resolveRequestedOutputPath(
        body,
        workspaceId,
        options.scope.layout.exportsDir(workspaceId),
      )
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

      const filePath =
        outputPath !== undefined
          ? await writeExplicitOutput(outputPath, pngBuffer)
          : await writeDefaultOutput(options.scope.layout, workspaceId, path, pngBuffer)
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

// The millisecond timestamp + nanoid(6) suffix is only probabilistically
// unique, not guaranteed — two exports racing in the same millisecond could
// still collide. `wx` makes the create fail loudly (EEXIST) instead of
// silently clobbering an earlier export, and a bounded retry with a fresh
// random suffix turns that rare collision into a transparent retry rather
// than a user-visible failure.
const MAX_DEFAULT_PATH_ATTEMPTS = 5

async function writeDefaultOutput(
  layout: DataLayout,
  workspaceId: string,
  path: string,
  pngBuffer: Buffer,
): Promise<string> {
  let lastFilePath: string | undefined
  for (let attempt = 0; attempt < MAX_DEFAULT_PATH_ATTEMPTS; attempt++) {
    const filePath = defaultExportPath(layout.exportsDir(workspaceId), path, 'png')
    lastFilePath = filePath
    await mkdir(dirname(filePath), { recursive: true })
    try {
      await writeFile(filePath, pngBuffer, { flag: 'wx' })
      return filePath
    } catch (err) {
      if (!isErrnoCode(err, 'EEXIST')) throw err
    }
  }
  throw new Error(
    `failed to generate a unique export filename after ${MAX_DEFAULT_PATH_ATTEMPTS} attempts (last tried: ${lastFilePath})`,
  )
}

// outputPath's existence was already validated up front (validateOutputPath,
// honoring `overwrite`), so a plain write is correct here — no `wx` retry
// needed for a caller-chosen path.
async function writeExplicitOutput(outputPath: string, pngBuffer: Buffer): Promise<string> {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, pngBuffer)
  return outputPath
}
