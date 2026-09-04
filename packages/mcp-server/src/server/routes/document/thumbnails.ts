import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { VersionStore } from '../../store/version-store.js'
import { validateVersionId, validationErrorBody } from '../../validators.js'
import { isValidPngSignature } from '../document-thumbnail.js'
import { handleCorruptStoredData } from './_shared.js'
import { onDocumentsRoute } from './path-route.js'

// Thumbnails are PNG blobs exported from the browser canvas. Match
// files.ts's MAX_FILE_UPLOAD_BYTES rather than inventing a separate number.
const THUMBNAIL_UPLOAD_LIMIT_BYTES = 16 * 1024 * 1024

export interface ThumbnailsRouterOptions {
  versionStore: VersionStore
}

// PUT /api/workspaces/:workspaceId/documents/:path/versions/:id/thumbnail
// GET /api/workspaces/:workspaceId/documents/:path/versions/:id/thumbnail
// GET /api/workspaces/:workspaceId/documents/:path/latest-thumbnail
export function createThumbnailsRouter(options: ThumbnailsRouterOptions) {
  const app = new Hono()
  const { versionStore } = options

  // Body is PNG binary from the browser exportToBlob result. Validate the PNG signature minimally.
  onDocumentsRoute(
    app,
    'put',
    ['versions', ':id', 'thumbnail'],
    async (c, workspaceId, path, params) => {
      const id = params.id as string
      try {
        validateVersionId(id)
      } catch (err) {
        const body = validationErrorBody(err)
        if (body) return c.json(body, 400)
        throw err
      }
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      if (!isValidPngSignature(bytes)) {
        return c.json({ error: 'invalid_png' }, 400)
      }
      try {
        await versionStore.saveThumbnail(workspaceId, path, id, bytes)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'save failed'
        return c.json({ error: 'save_failed', message: msg }, 400)
      }
      return c.json({ ok: true })
    },
    {},
    bodyLimit({
      maxSize: THUMBNAIL_UPLOAD_LIMIT_BYTES,
      onError: (c) =>
        c.json(
          {
            error: 'payload_too_large',
            message: `Upload exceeds ${THUMBNAIL_UPLOAD_LIMIT_BYTES} bytes limit.`,
          },
          413,
        ),
    }),
  )

  // Return the PNG with cache headers, or 404 if it has not been saved.
  onDocumentsRoute(
    app,
    'get',
    ['versions', ':id', 'thumbnail'],
    async (c, workspaceId, path, params) => {
      const id = params.id as string
      try {
        validateVersionId(id)
      } catch (err) {
        const body = validationErrorBody(err)
        if (body) return c.json(body, 400)
        throw err
      }
      try {
        const bytes = await versionStore.loadThumbnail(workspaceId, path, id)
        if (!bytes) return c.json({ error: 'not_found' }, 404)
        return c.body(bytes.buffer as ArrayBuffer, 200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=3600, immutable',
        })
      } catch (err) {
        const issue = handleCorruptStoredData(err)
        if (issue) return c.json(issue.body, issue.status)
        throw err
      }
    },
  )

  // Return the newest version thumbnail for canvas-switcher previews.
  // "Newest" means the first hasThumbnail=true entry in version list order (createdAt desc).
  // Keep max-age short (5 min) so fresh auto-save thumbnails replace cached ones promptly.
  onDocumentsRoute(app, 'get', ['latest-thumbnail'], async (c, workspaceId, path) => {
    try {
      const versions = await versionStore.list(workspaceId, path)
      const latestWithThumb = versions.find((v) => v.hasThumbnail)
      // No thumbnail yet is a normal state (a brand-new document has none).
      // A client points an <img> at this route, so a 404 would make its
      // browser log "Failed to load resource: 404" as console noise for a
      // valid question. Return 204 No Content instead: a success status, so
      // nothing is logged, whose empty body still trips <img> onError and
      // lets the client draw its own placeholder.
      if (!latestWithThumb) return c.body(null, 204)
      const bytes = await versionStore.loadThumbnail(workspaceId, path, latestWithThumb.id)
      if (!bytes) return c.body(null, 204)
      return c.body(bytes.buffer as ArrayBuffer, 200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=300',
      })
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  return app
}
