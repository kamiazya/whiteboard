import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getDataDir } from '../config.js'
import {
  corruptStoredData,
  corruptStoredDataBody,
  isMissingFileError,
} from '../store/corrupt-stored-data.js'
import { purgeDanglingFiles } from '../store/file-gc.js'
import type { VersionStore } from '../store/version-store.js'
import {
  validateFileId,
  validateSlug,
  validateWorkspaceId,
  validationErrorBody,
} from '../validators.js'

// Per-file size limit. Loro thumbnails are around 2 MiB and assets pasted into
// Excalidraw normally fit inside this range. Return 413 when exceeded to avoid
// runaway memory usage from malicious large uploads.
const MAX_FILE_UPLOAD_BYTES = 16 * 1024 * 1024

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
}

const EXT_TO_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_TO_EXT).map(([m, e]) => [e, m]),
)

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'unknown error'
}

async function readStoredFileNames(dir: string): Promise<string[] | null> {
  try {
    return await readdir(dir)
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }
    throw corruptStoredData(dir, `failed to read files directory (${errorMessage(error)})`)
  }
}

export interface FilesRouterOptions {
  // Provide a versionStore for version-aware purge. Without one, the
  // purge endpoint walks only the live state of each canvas and leaves
  // files referenced exclusively by saved versions untouched.
  versionStore?: VersionStore
}

export function createFilesRouter(options: FilesRouterOptions = {}) {
  const app = new Hono()

  // PUT /api/canvas/:workspaceId/:slug/file/:fileId
  // Called by MCP load_image. fileId is already generated on the MCP side with nanoid().
  app.put(
    '/api/canvas/:workspaceId/:slug/file/:fileId',
    bodyLimit({
      maxSize: MAX_FILE_UPLOAD_BYTES,
      onError: (c) =>
        c.json(
          {
            error: 'payload_too_large',
            message: `Upload exceeds ${MAX_FILE_UPLOAD_BYTES} bytes limit.`,
          },
          413,
        ),
    }),
    async (c) => {
      const { workspaceId, slug, fileId } = c.req.param()
      try {
        validateWorkspaceId(workspaceId)
        validateSlug(slug)
        validateFileId(fileId)
      } catch (err) {
        const body = validationErrorBody(err)
        if (body) return c.json(body, 400)
        throw err
      }
      const mimeType = c.req.header('Content-Type') ?? 'image/png'
      const ext = MIME_TO_EXT[mimeType]
      if (!ext) {
        return c.json(
          {
            error: 'unsupported_media_type',
            message: `Unsupported Content-Type: ${mimeType}. Allowed: ${Object.keys(MIME_TO_EXT).join(', ')}`,
          },
          415,
        )
      }
      const dir = join(getDataDir(), workspaceId, 'files')
      await mkdir(dir, { recursive: true })
      const filePath = join(dir, `${fileId}${ext}`)
      await writeFile(filePath, new Uint8Array(await c.req.arrayBuffer()))
      return c.body(null, 204)
    },
  )

  // GET /api/canvas/:workspaceId/:slug/file/:fileId
  // Browser-facing route. Find a file under files/ whose stem matches fileId exactly.
  app.get('/api/canvas/:workspaceId/:slug/file/:fileId', async (c) => {
    const { workspaceId, slug, fileId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
      validateSlug(slug)
      validateFileId(fileId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const dir = join(getDataDir(), workspaceId, 'files')
      const files = await readStoredFileNames(dir)
      if (!files) {
        return c.notFound()
      }

      // startsWith(fileId) would allow prefix matches and can return the wrong file,
      // so check basename + extname for exact equality.
      const match = files.find((f) => basename(f, extname(f)) === fileId)
      if (!match) {
        return c.notFound()
      }

      const filePath = join(dir, match)
      let data: Uint8Array
      try {
        data = await readFile(filePath)
      } catch (error) {
        throw corruptStoredData(filePath, `failed to read stored file (${errorMessage(error)})`)
      }

      const fileExt = extname(match)
      return c.body(data.buffer as ArrayBuffer, 200, {
        'Content-Type': EXT_TO_MIME[fileExt] ?? 'application/octet-stream',
      })
    } catch (error) {
      const body = corruptStoredDataBody(error)
      if (body) return c.json(body, 500)
      throw error
    }
  })

  // POST /api/workspaces/:workspaceId/files/purge-dangling
  // Delete files under <workspaceId>/files/ whose stem is not referenced
  // by any image element in the workspace's live canvases OR any branch
  // tip (main and every other branch), and — when a versionStore is
  // supplied — any saved version either. Safe and idempotent; a file is
  // only ever removed once nothing across that full reference set points
  // at it, so branch/version restore never regresses to a broken image.
  app.post('/api/workspaces/:workspaceId/files/purge-dangling', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const result = await purgeDanglingFiles(workspaceId, {
        versionStore: options.versionStore,
      })
      return c.json(result)
    } catch (err) {
      const body = corruptStoredDataBody(err)
      if (body) return c.json(body, 500)
      throw err
    }
  })

  return app
}
