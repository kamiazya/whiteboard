import { mkdir, readdir, readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import {
  isUploadableImageType,
  UPLOADABLE_IMAGE_TYPES,
  type UploadableImageType,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/files'
import { messageOf } from '@kamiazya/whiteboard-model'
import { Hono } from 'hono'
import { isMissingFileError } from '../../shared/errno.js'
import { writeFileAtomicStaged } from '../atomic-write.js'
import { corruptStoredData, corruptStoredDataBody } from '../store/corrupt-stored-data.js'
import {
  filesDirNotContainedErrorBody,
  type GcVersionReader,
  incompleteFileGcScanErrorBody,
  purgeDanglingFiles,
} from '../store/file-gc.js'
import type { StoreScope } from '../store/store-scope.js'
import { withWorkspaceWriteLock } from '../store/workspace-lock.js'
import { validateFileId, validationErrorBody } from '../validators.js'
import { parseWorkspaceHandle } from '../workspace-handle.js'
import { CONTENT_BODY_LIMIT_BYTES, limitBody } from './body-limit.js'
import { onDocumentFile } from './document/path-route.js'

// The set of types and the per-file ceiling are the contract the editor
// checks a pick against (api-contracts/files); only the on-disk extension is
// the route's own, keyed by that set so a type added there without one fails
// to compile instead of answering 415 for a type the editor offers.
const MIME_TO_EXT: Record<UploadableImageType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
}

const EXT_TO_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_TO_EXT).map(([m, e]) => [e, m]),
)

async function readStoredFileNames(dir: string): Promise<string[] | null> {
  try {
    return await readdir(dir)
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }
    throw corruptStoredData(dir, `failed to read files directory (${messageOf(error)})`)
  }
}

// SVG is the one uploadable type that is a document rather than pixels: it can
// carry script, and a top-level navigation to its URL would run it in the
// app's origin. The sandbox (no `allow-scripts`, no `allow-same-origin`) and
// `default-src 'none'` stop it executing or fetching anything, and the
// attachment disposition makes a navigation download instead of render. Neither
// affects `<img src>` or a blob made from fetch(), which is how the editor
// shows it. `setBaselineSecurityHeaders` leaves a CSP a route already chose.
function fileHeaders(contentType: string, fileId: string): Record<string, string> {
  if (contentType !== 'image/svg+xml') return { 'Content-Type': contentType }
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'Content-Disposition': `attachment; filename="${fileId}.svg"`,
  }
}

/**
 * What the purge route answers for each way a purge refuses. 503: a unit the
 * scan must judge (version, trash bytes, node) could not be read — corrupt or
 * not, nothing was deleted, and a retry helps only if the failure was
 * transient; the log names the unit. 500: the workspace record will not
 * decode, so there is no reference set; or the files directory resolves
 * outside the data dir, which no retry changes and the log names the hop.
 */
function purgeRefusal(
  err: unknown,
): { body: { error: string; message: string }; status: 500 | 503 } | null {
  const incompleteScan = incompleteFileGcScanErrorBody(err)
  if (incompleteScan) return { body: incompleteScan, status: 503 }
  const body = filesDirNotContainedErrorBody(err) ?? corruptStoredDataBody(err)
  return body ? { body, status: 500 } : null
}

export interface FilesRouterOptions {
  /**
   * The directory and tenant these routes serve: where a workspace's files are
   * stored, the data dir uploads are written atomically under, and what the
   * purge reads its references from.
   */
  scope: StoreScope
  /** The saved versions the purge keeps every image of. */
  versionStore: GcVersionReader
}

/**
 * One stored file by its stem, or `null` when this document has none —
 * which is a refusal for the caller to shape, not an error.
 *
 * Matched on basename + extname equality rather than `startsWith`: a prefix
 * match would answer `a1` with `a12`'s bytes.
 */
async function storedFileFor(
  dir: string,
  fileId: string,
): Promise<{ data: Uint8Array<ArrayBuffer>; contentType: string } | null> {
  const files = await readStoredFileNames(dir)
  if (!files) return null
  const match = files.find((f) => basename(f, extname(f)) === fileId)
  if (!match) return null

  const filePath = join(dir, match)
  let data: Uint8Array<ArrayBuffer>
  try {
    data = await readFile(filePath)
  } catch (error) {
    throw corruptStoredData(filePath, `failed to read stored file (${messageOf(error)})`)
  }
  // The upload refuses an empty body, so an empty stored file is one this
  // route never wrote whole: a torn write or a damaged restore. Served as a
  // 200 it would be an image that draws nothing, and pages cache it as one.
  if (data.length === 0) throw corruptStoredData(filePath, 'stored file is empty')
  return { data, contentType: EXT_TO_MIME[extname(match)] ?? 'application/octet-stream' }
}

export function createFilesRouter(options: FilesRouterOptions) {
  const app = new Hono()
  const { scope, versionStore } = options

  // PUT /api/w/:workspaceId/document/<path>/file/:fileId
  // Called by MCP load_image. fileId is already generated on the MCP side with nanoid().
  onDocumentFile(
    app,
    'put',
    async (c, workspaceId, _path, fileId) => {
      try {
        validateFileId(fileId)
      } catch (err) {
        const body = validationErrorBody(err)
        if (body) return c.json(body, 400)
        throw err
      }
      const mimeType = c.req.header('Content-Type') ?? 'image/png'
      if (!isUploadableImageType(mimeType)) {
        return c.json(
          {
            error: 'unsupported_media_type',
            message: `Unsupported Content-Type: ${mimeType}. Allowed: ${UPLOADABLE_IMAGE_TYPES.join(', ')}`,
          },
          415,
        )
      }
      const ext = MIME_TO_EXT[mimeType]
      const dir = scope.layout.workspaceFilesDir(workspaceId)
      const filePath = join(dir, `${fileId}${ext}`)
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      if (bytes.length === 0) {
        return c.json({ error: 'empty_body', message: 'An upload carries the file bytes.' }, 400)
      }
      // file-gc's purge pass stat()s then unlink()s dangling files while
      // holding this same per-workspace lock (file-gc.ts / workspace-lock.ts).
      // Without joining that lock here, a retried upload could land between
      // GC's stat() and unlink() and have its freshly written file deleted
      // as the stale one it was replacing.
      await withWorkspaceWriteLock(workspaceId, async () => {
        await mkdir(dir, { recursive: true })
        // Atomic, so a reader — or a backup copying this tree while the
        // server runs — never sees the upload half-written. A plain write
        // leaves the file short for its whole duration: measured, a copy
        // overlapping an in-flight 8 MiB upload captured a torn file 2 times
        // out of 10, which is worse than always, because a backup then holds
        // a corrupt image only sometimes.
        await writeFileAtomicStaged(scope.dataDir, filePath, bytes)
      })
      return c.body(null, 204)
    },
    limitBody(CONTENT_BODY_LIMIT_BYTES, 'Upload'),
  )

  // GET /api/w/:workspaceId/document/<path>/file/:fileId
  // Browser-facing route. Find a file under files/ whose stem matches fileId exactly.
  onDocumentFile(app, 'get', async (c, workspaceId, _path, fileId) => {
    try {
      validateFileId(fileId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const found = await storedFileFor(scope.layout.workspaceFilesDir(workspaceId), fileId)
      // JSON like every other refusal here: `c.notFound()` is plain text,
      // which the browser client cannot read.
      if (found === null) {
        return c.json({ error: 'not_found', message: `No file ${fileId} on this document.` }, 404)
      }
      // The view, never its `.buffer`: a Buffer's backing store can outrun
      // the file (a pooled allocation), and the rest is process memory.
      return c.body(found.data, 200, fileHeaders(found.contentType, fileId))
    } catch (error) {
      const body = corruptStoredDataBody(error)
      if (body) return c.json(body, 500)
      throw error
    }
  })

  // POST /api/workspaces/:workspaceId/files/purge-dangling
  // Delete the files nothing a user can still reach names — live documents
  // by id, trash bytes, saved versions of a document a path reaches (not a
  // trashed or shadowed one's yet: file-gc.ts's `versionReads`), and what an
  // open proposal in any of them would draw. Idempotent.
  app.post('/api/workspaces/:workspaceId/files/purge-dangling', async (c) => {
    const address = await parseWorkspaceHandle(c, c.req.param('workspaceId'))
    if ('refusal' in address) return address.refusal
    const { workspaceId } = address
    try {
      const result = await purgeDanglingFiles(workspaceId, { versionStore, scope })
      return c.json(result)
    } catch (err) {
      const refusal = purgeRefusal(err)
      if (refusal) return c.json(refusal.body, refusal.status)
      throw err
    }
  })

  return app
}
