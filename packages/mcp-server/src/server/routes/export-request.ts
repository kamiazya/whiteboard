import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SpatialRenderStyle } from '@kamiazya/whiteboard-canvas-render'
import {
  type ApiErrorBody,
  errorBody,
  invalidRequestBody,
  unknownStyleRefusal,
} from '@kamiazya/whiteboard-server-core'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { nanoid } from 'nanoid'
import type { z } from 'zod'
import { isErrnoCode } from '../../shared/errno.js'
import { OutputPathError, validateOutputPath } from '../output-path.js'
import type { DataLayout } from '../tenant/data-layout-seam.js'
import { toDocumentOutputPathErrorBody } from './document-output-path-error.js'
import { readJsonBody } from './read-json-body.js'

// What every export format asks of a request before it renders, in the one
// order they all answer in: the body, then the output path, then whether the
// document exists. A caller is told its request is wrong before it is told
// the document is missing, the way the other document routes answer.
//
// And where every format's file lands: both the check on a caller-chosen path
// and the default path are taken against the layout's exports directory here,
// so the formats cannot disagree about it.

/** The one fact about the layout an export needs: where a workspace's exports go. */
type ExportsLayout = Pick<DataLayout, 'exportsDir'>

/**
 * `undefined` means the caller named no path, which is not a refusal — the
 * handler then writes to the workspace's default exports directory. A path
 * that IS named is checked before anything is rendered: relative paths,
 * paths outside the exports directory and pre-existing files (unless
 * `overwrite`) refuse here rather than after the render they would have wasted.
 */
export async function resolveRequestedOutputPath(
  body: { outputPath?: string; overwrite?: boolean },
  workspaceId: string,
  layout: ExportsLayout,
): Promise<
  { outputPath: string | undefined } | { error: ApiErrorBody; status: ContentfulStatusCode }
> {
  if (typeof body.outputPath !== 'string' || body.outputPath.length === 0) {
    return { outputPath: undefined }
  }
  try {
    await validateOutputPath(
      body.outputPath,
      body.overwrite === true,
      layout.exportsDir(workspaceId),
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
function defaultExportPath(exportsDir: string, path: string, extension: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(exportsDir, `${path}-${timestamp}-${nanoid(6)}.${extension}`)
}

// The suffix makes a collision rare, not impossible, so the default path is
// created with `wx`: a collision fails loudly (EEXIST) instead of silently
// replacing an earlier export, and a bounded retry with a fresh suffix turns
// that rare failure into a transparent one.
const MAX_DEFAULT_PATH_ATTEMPTS = 5

/**
 * Writes a rendered export and answers where it landed — the one write policy
 * every export format shares. A caller-chosen `outputPath` was already checked
 * by {@link resolveRequestedOutputPath}, honouring `overwrite`, so it is
 * written as-is; without one, the file goes to a fresh default path in the
 * workspace's exports directory and never replaces a file already there.
 */
export async function writeExportFile(
  data: string | Uint8Array,
  target: {
    outputPath: string | undefined
    layout: ExportsLayout
    workspaceId: string
    path: string
    extension: string
  },
): Promise<string> {
  if (target.outputPath !== undefined) {
    await mkdir(dirname(target.outputPath), { recursive: true })
    await writeFile(target.outputPath, data)
    return target.outputPath
  }
  let lastFilePath: string | undefined
  for (let attempt = 0; attempt < MAX_DEFAULT_PATH_ATTEMPTS; attempt++) {
    const filePath = defaultExportPath(
      target.layout.exportsDir(target.workspaceId),
      target.path,
      target.extension,
    )
    lastFilePath = filePath
    await mkdir(dirname(filePath), { recursive: true })
    try {
      await writeFile(filePath, data, { flag: 'wx' })
      return filePath
    } catch (err) {
      if (!isErrnoCode(err, 'EEXIST')) throw err
    }
  }
  throw new Error(
    `failed to generate a unique export filename after ${MAX_DEFAULT_PATH_ATTEMPTS} attempts (last tried: ${lastFilePath})`,
  )
}

/**
 * An export's JSON body, which may be empty — every export option has a
 * default — so only a body that is PRESENT and unreadable refuses. A `style`
 * that names a theme nothing registered is refused as part of the same check.
 *
 * Such an id draws the clean look, so an export answered 200 for a typo and a
 * caller could not tell it had not got the theme it asked for. The text is
 * `wb_scene_render`'s, because both call server-core's `unknownStyleRefusal`.
 * It is a request-body check, so it answers before the output path and the
 * document lookup, in the order this file's header fixes.
 */
export async function readExportBody<S extends z.ZodType<{ style?: SpatialRenderStyle }>>(
  c: Context,
  schema: S,
): Promise<{ data: z.infer<S> } | { refusal: Response }> {
  const read = await readJsonBody(c, schema, {
    voice: 'code',
    optional: true,
    refuseShape: invalidRequestBody,
  })
  if ('refusal' in read) return read
  const refusal = unknownStyleRefusal(read.data.style)
  if (refusal === undefined) return read
  return { refusal: c.json(errorBody('invalid_request', refusal), 400) }
}
