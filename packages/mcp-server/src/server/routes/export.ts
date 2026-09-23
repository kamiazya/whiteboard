import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
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
import { documentExists } from '../store/document-store.js'
import { onDocumentAction } from './document/path-route.js'
import { toDocumentOutputPathErrorBody } from './document-output-path-error.js'

// The body is a small JSON options object (padding/scale/frameId/theme/
// outputPath), never canvas content — the PNG is always rendered headlessly
// from the persisted document. 1 MiB is a generous ceiling for that shape
// while still bounding an adversarial request.
const EXPORT_OPTIONS_BODY_LIMIT_BYTES = 1024 * 1024

/**
 * An empty body is a valid export request — every option has a default — so
 * only a body that is PRESENT and unreadable refuses.
 */
function parseExportBody(
  rawText: string,
): { body: z.infer<typeof exportRequestSchema> } | { error: ExportErrorBody } {
  if (rawText.length === 0) return { body: {} }
  let json: unknown
  try {
    json = JSON.parse(rawText)
  } catch {
    return { error: { error: 'invalid_request', message: 'malformed JSON' } }
  }
  const parsed = exportRequestSchema.safeParse(json)
  if (!parsed.success) {
    return { error: { error: 'invalid_request', message: 'invalid export options' } }
  }
  return { body: parsed.data }
}

/**
 * `undefined` means the caller named no path, which is not a refusal — the
 * handler then writes to the workspace's default exports directory. A path
 * that IS named is checked before anything is rendered: relative paths and
 * pre-existing files (unless `overwrite`) refuse here rather than after the
 * render they would have wasted.
 */
async function resolveExportOutputPath(
  body: { outputPath?: string; overwrite?: boolean },
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
      return { error: errBody, status }
    }
    throw err
  }
  return { outputPath: body.outputPath }
}

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
): Promise<
  | Awaited<ReturnType<typeof renderHeadless>>
  | { error: ExportErrorBody; status: ContentfulStatusCode }
> {
  try {
    return await renderHeadless(workspaceId, path, body)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/target size is zero/i.test(message)) {
      return {
        error: { error: 'invalid_request', message: `invalid export options: ${message}` },
        status: 400,
      }
    }
    return { error: { error: 'headless_export_failed', message }, status: 500 }
  }
}

export function createExportRouter() {
  const app = new Hono()

  // POST /api/w/:workspaceId/document/<path>/export
  onDocumentAction(
    app,
    'post',
    'export',
    async (c, workspaceId, path) => {
      const parsedBody = parseExportBody(await c.req.text())
      if ('error' in parsedBody) return c.json(parsedBody.error, 400)
      const body = parsedBody.body

      // Validated up front, before rendering, so the caller does not waste a
      // render on a write that will fail.
      const resolved = await resolveExportOutputPath(body, workspaceId)
      if ('error' in resolved) return c.json(resolved.error, resolved.status)
      const outputPath = resolved.outputPath

      // The headless path operates directly on the LoroDoc and does NOT
      // verify that the canvas actually exists — getDoc / loadDocument return
      // an empty doc on cache miss, so a typoed path would otherwise emit a
      // blank PNG. Reject up front with 404 so callers learn about the typo
      // instead of shipping the silently-empty file.
      if (!(await documentExists(workspaceId, path))) {
        const errBody: ExportErrorBody = {
          error: 'canvas_not_found',
          message: `Canvas not found: ${workspaceId}/${path}`,
        }
        return c.json(errBody, 404)
      }

      const rendered = await renderedExport(workspaceId, path, body)
      if ('error' in rendered) return c.json(rendered.error, rendered.status)
      const { png: pngBuffer, undrawable, unresolvedFamilies } = rendered

      const filePath =
        outputPath !== undefined
          ? await writeExplicitOutput(outputPath, pngBuffer)
          : await writeDefaultOutput(workspaceId, path, pngBuffer)
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

async function renderHeadless(
  workspaceId: string,
  path: string,
  body: z.infer<typeof exportRequestSchema>,
): Promise<{
  png: Buffer
  undrawable: readonly string[]
  unresolvedFamilies: readonly string[]
}> {
  const result = await exportCanvasHeadless({
    workspaceId,
    path,
    options: {
      padding: body.padding,
      scale: body.scale,
      frameId: body.frameId,
      minFontPx: body.minFontPx,
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

// A plain PNG: the headless renderer no longer embeds scene JSON, so a
// `.excalidraw.png` suffix would falsely claim the file is re-importable as
// a scene.
function defaultExportPath(workspaceId: string, path: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const fileName = `${path}-${timestamp}-${nanoid(6)}.png`
  return join(getDataDir(), workspaceId, 'exports', fileName)
}

// The millisecond timestamp + nanoid(6) suffix is only probabilistically
// unique, not guaranteed — two exports racing in the same millisecond could
// still collide. `wx` makes the create fail loudly (EEXIST) instead of
// silently clobbering an earlier export, and a bounded retry with a fresh
// random suffix turns that rare collision into a transparent retry rather
// than a user-visible failure.
const MAX_DEFAULT_PATH_ATTEMPTS = 5

async function writeDefaultOutput(
  workspaceId: string,
  path: string,
  pngBuffer: Buffer,
): Promise<string> {
  let lastFilePath: string | undefined
  for (let attempt = 0; attempt < MAX_DEFAULT_PATH_ATTEMPTS; attempt++) {
    const filePath = defaultExportPath(workspaceId, path)
    lastFilePath = filePath
    await mkdir(dirname(filePath), { recursive: true })
    try {
      await writeFile(filePath, pngBuffer, { flag: 'wx' })
      return filePath
    } catch (err) {
      if (!isEexist(err)) throw err
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

function isEexist(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST'
}
