import { join } from 'node:path'
import type { SpatialRenderStyle } from '@kamiazya/whiteboard-canvas-render'
import {
  type ApiErrorBody,
  invalidRequestBody,
  unknownStyleRefusal,
} from '@kamiazya/whiteboard-server-core'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { nanoid } from 'nanoid'
import type { z } from 'zod'
import { OutputPathError, validateOutputPath } from '../output-path.js'
import { toDocumentOutputPathErrorBody } from './document-output-path-error.js'

// What every export format asks of a request before it renders, in the one
// order they all answer in: the body, then the output path, then whether the
// document exists. A caller is told its request is wrong before it is told
// the document is missing, the way the other document routes answer.

/**
 * An empty body is a valid export request — every option has a default — so
 * only a body that is PRESENT and unreadable refuses.
 */
function parseOptionalJsonBody<S extends z.ZodType>(
  rawText: string,
  schema: S,
): { body: z.infer<S> } | { error: ApiErrorBody } {
  let json: unknown = {}
  if (rawText.length > 0) {
    try {
      json = JSON.parse(rawText)
    } catch {
      return { error: { error: 'invalid_request', message: 'malformed JSON' } }
    }
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) return { error: invalidRequestBody(parsed.error) }
  return { body: parsed.data }
}

/**
 * `undefined` means the caller named no path, which is not a refusal — the
 * handler then writes to the workspace's default exports directory. A path
 * that IS named is checked before anything is rendered: relative paths,
 * paths outside `exportsDir` and pre-existing files (unless `overwrite`)
 * refuse here rather than after the render they would have wasted.
 */
export async function resolveRequestedOutputPath(
  body: { outputPath?: string; overwrite?: boolean },
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

/**
 * The headless renderer answers a document that does not exist with an EMPTY
 * one, so a typoed path would otherwise return 200 and a valid-looking image
 * of nothing — hence the refusal before rendering.
 */
export function documentMissingBody(workspaceId: string, path: string): ApiErrorBody {
  return { error: 'not_found', message: `Document not found: ${workspaceId}/${path}` }
}

/**
 * The millisecond timestamp alone is not unique: two exports issued fast
 * enough to land in the same millisecond would collide, so the random suffix
 * is what makes the name unique regardless of call timing.
 */
export function defaultExportPath(exportsDir: string, path: string, extension: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(exportsDir, `${path}-${timestamp}-${nanoid(6)}.${extension}`)
}

/**
 * `parseOptionalJsonBody`, and a `style` that names a theme nothing registered
 * is refused as part of the same body check.
 *
 * Such an id draws the clean look, so an export answered 200 for a typo and a
 * caller could not tell it had not got the theme it asked for. The text is
 * `wb_scene_render`'s, because both call server-core's `unknownStyleRefusal`.
 * It is a request-body check, so it answers before the output path and the
 * document lookup, in the order `export-request.ts` fixes.
 */
export function parseExportBody<S extends z.ZodType<{ style?: SpatialRenderStyle }>>(
  rawText: string,
  schema: S,
): { body: z.infer<S> } | { error: ApiErrorBody } {
  const parsed = parseOptionalJsonBody(rawText, schema)
  if ('error' in parsed) return parsed
  const refusal = unknownStyleRefusal(parsed.body.style)
  if (refusal === undefined) return parsed
  return { error: { error: 'invalid_request', message: refusal } }
}
