/**
 * The daemon binding of the editor's file seams (see use-canvas-file-seams.ts
 * for the backend-agnostic half).
 *
 * Every method is total: a missing file, a rejected upload, or an unreachable
 * daemon resolves to `undefined` so the editor keeps the card. A broken
 * reference must never take the page down, and it must never be reported as
 * success either — an upload that failed returns undefined rather than a
 * reference to bytes the daemon never stored.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { imageRefId, isImageRef, newImageRef } from '@kamiazya/whiteboard-canvas-model'
import { readCoreFacets, readSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { Loro } from 'loro-crdt'
import type { CanvasFileAdapter } from '../hooks/use-canvas-file-seams.js'
import { getAppLogger } from './app-logger.js'

const log = getAppLogger('daemon-file-adapter')

export interface DaemonFileAdapterOptions {
  readonly daemonFetch: typeof fetch
  readonly daemonBaseUrl: string
  readonly workspaceId: string
  readonly slug: string
  /**
   * Maps an immutable canvas id to its CURRENT slug (undefined when the
   * ref is not a known id). New file nodes store ids so a slug rename
   * cannot dangle them; the daemon's read routes stay slug-addressed, so
   * resolution happens here. Refs are resolved by LOOKUP, never by format:
   * the id alphabet overlaps the slug charset, so an unknown ref is
   * treated as a legacy slug reference.
   */
  readonly resolveRefSlug?: (ref: string) => string | undefined
}

export function createDaemonFileAdapter({
  daemonFetch,
  daemonBaseUrl,
  workspaceId,
  slug,
  resolveRefSlug,
}: DaemonFileAdapterOptions): CanvasFileAdapter {
  const canvasPath = (target: string) =>
    `${daemonBaseUrl}/api/canvas/${workspaceId}/${encodeURIComponent(target)}`

  return {
    isImageRef,

    async loadDocument(ref) {
      try {
        const target = resolveRefSlug?.(ref) ?? ref
        const res = await daemonFetch(`${canvasPath(target)}/snapshot`)
        if (!res.ok) return undefined
        const doc = new Loro()
        doc.import(new Uint8Array(await res.arrayBuffer()))
        // One snapshot, both reads: the doc used to be discarded after the
        // canvas read, which is why facets needed no second request.
        return { canvas: readSpatialCanvas(doc) as SpatialCanvas, facets: readCoreFacets(doc) }
      } catch (err) {
        log.warn('referenced document load failed', { ref, err })
        return undefined
      }
    },

    async loadImageUrl(ref) {
      try {
        // This canvas's own slug, not the reference: the file route scopes
        // reads by the canvas that owns the workspace's file directory.
        const res = await daemonFetch(`${canvasPath(slug)}/file/${imageRefId(ref)}`)
        if (!res.ok) return undefined
        return URL.createObjectURL(await res.blob())
      } catch (err) {
        log.warn('image load failed', { ref, err })
        return undefined
      }
    },

    async storeImage(file) {
      const id = crypto.randomUUID()
      try {
        const res = await daemonFetch(`${canvasPath(slug)}/file/${id}`, {
          method: 'PUT',
          // The route answers 415 for a Content-Type it has no extension
          // mapping for, so the picked file's own type has to travel.
          headers: { 'Content-Type': file.type },
          body: file,
        })
        if (!res.ok) {
          log.warn('image upload rejected', { status: res.status })
          return undefined
        }
        return newImageRef(id)
      } catch (err) {
        log.warn('image upload failed', { err })
        return undefined
      }
    },
  }
}
