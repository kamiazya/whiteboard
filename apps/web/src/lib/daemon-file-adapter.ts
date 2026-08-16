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

import { readCoreFacets, readMarkdownBody, readSpatialCanvas } from '@kamiazya/whiteboard-crdt'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { imageRefId, isImageRef, newImageRef } from '@kamiazya/whiteboard-model'
import { Loro } from 'loro-crdt'
import type { CanvasFileAdapter } from '../hooks/use-canvas-file-seams.js'
import { getAppLogger } from './app-logger.js'

const log = getAppLogger('daemon-file-adapter')

export interface DaemonFileAdapterOptions {
  readonly daemonFetch: typeof fetch
  readonly daemonBaseUrl: string
  readonly workspaceId: string
  readonly path: string
  /**
   * Maps an immutable canvas id to its CURRENT path (undefined when the
   * ref is not a known id). New file nodes store ids so a path rename
   * cannot dangle them; the daemon's read routes stay path-addressed, so
   * resolution happens here. Refs are resolved by LOOKUP, never by format:
   * the id alphabet overlaps the path charset, so an unknown ref is
   * treated as a legacy path reference.
   */
  readonly resolveRefPath?: (ref: string) => string | undefined
}

export function createDaemonFileAdapter({
  daemonFetch,
  daemonBaseUrl,
  workspaceId,
  path,
  resolveRefPath,
}: DaemonFileAdapterOptions): CanvasFileAdapter {
  const canvasPath = (target: string) =>
    `${daemonBaseUrl}/api/w/${encodeURIComponent(workspaceId)}/canvas/${encodeURIComponent(target)}`

  return {
    isImageRef,

    async loadDocument(ref) {
      try {
        const target = resolveRefPath?.(ref) ?? ref
        const res = await daemonFetch(`${canvasPath(target)}/snapshot`)
        if (!res.ok) return undefined
        const doc = new Loro()
        doc.import(new Uint8Array(await res.arrayBuffer()))
        // One snapshot, every read: the doc used to be discarded after the
        // canvas read, which is why neither facets nor the body need a
        // second request.
        const body = readMarkdownBody(doc)
        return {
          canvas: readSpatialCanvas(doc) as SpatialCanvas,
          facets: readCoreFacets(doc),
          ...(body.length > 0 ? { body } : {}),
        }
      } catch (err) {
        log.warn('referenced document load failed', { ref, err })
        return undefined
      }
    },

    async loadImageUrl(ref) {
      try {
        // This canvas's own path, not the reference: the file route scopes
        // reads by the canvas that owns the workspace's file directory.
        const res = await daemonFetch(`${canvasPath(path)}/file/${imageRefId(ref)}`)
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
        const res = await daemonFetch(`${canvasPath(path)}/file/${id}`, {
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
