import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
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

export function createExportRouter() {
  const app = new Hono()

  // POST /api/w/:workspaceId/document/<path>/export
  onDocumentAction(
    app,
    'post',
    'export',
    async (c, workspaceId, path) => {
      // The body is optional. Empty body is fine; malformed JSON or
      // schema-invalid payloads are rejected with 400 instead of being
      // silently dropped.
      const rawText = await c.req.text()
      let body: z.infer<typeof exportRequestSchema> = {}
      if (rawText.length > 0) {
        let json: unknown
        try {
          json = JSON.parse(rawText)
        } catch {
          const errBody: ExportErrorBody = { error: 'invalid_request', message: 'malformed JSON' }
          return c.json(errBody, 400)
        }
        const parsed = exportRequestSchema.safeParse(json)
        if (!parsed.success) {
          const errBody: ExportErrorBody = {
            error: 'invalid_request',
            message: 'invalid export options',
          }
          return c.json(errBody, 400)
        }
        body = parsed.data
      }

      // Validate outputPath up front, before rendering. Reject relative
      // paths and pre-existing files (unless overwrite=true) so the caller
      // does not waste a render on a write that will fail.
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
            const { status, body: errBody } = toDocumentOutputPathErrorBody(err, workspaceId)
            return c.json(errBody as ExportErrorBody, status)
          }
          throw err
        }
        outputPath = body.outputPath
      }

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

      let pngBuffer: Buffer
      let undrawable: readonly string[]
      let unresolvedFamilies: readonly string[]
      try {
        ;({
          png: pngBuffer,
          undrawable,
          unresolvedFamilies,
        } = await renderHeadless(workspaceId, path, body))
      } catch (err) {
        const errBody: ExportErrorBody = {
          error: 'headless_export_failed',
          message: err instanceof Error ? err.message : String(err),
        }
        return c.json(errBody, 500)
      }

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
