/**
 * The daemon binding of the editor's file seams (see use-document-file-seams.ts
 * for the backend-agnostic half).
 *
 * A missing file resolves to `undefined` so the editor keeps the card, and a
 * rejected upload or an unreachable daemon answers a refusal with its reason.
 * A failed READ — of a document or a picture — rejects, per the contract, so
 * the seam that caches it can tell a transient failure from an absence. A
 * broken reference must never take the page down, and it must never be
 * reported as success either — an upload that failed carries no reference to
 * bytes the daemon never stored.
 */

import {
  documentApiUrl,
  documentFileApiUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document-url'
import { imageRefId, isImageRef, newImageRef } from '@kamiazya/whiteboard-model'
import { Loro } from 'loro-crdt'
import { getAppLogger } from './app-logger.js'
import { readDaemonImage } from './daemon-image-read.js'
import type { DocumentFileAdapter, LoadedFileDocument } from './document-file-contract.js'
import { uploadRefusalReason } from './image-upload-policy.js'
import { readLoadedFileDocument } from './read-loaded-file-document.js'

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

const objectUrlOf = (blob: Blob | undefined) =>
  blob === undefined ? undefined : URL.createObjectURL(blob)

/**
 * One referenced document off the daemon's snapshot route. Only a 404 is
 * "absent": the contract caches that answer as terminal, so a busy database,
 * a server error or a dropped request rejects and is asked again.
 */
async function loadSnapshotDocument(
  daemonFetch: typeof fetch,
  url: string,
  ref: string,
): Promise<LoadedFileDocument | undefined> {
  try {
    const res = await daemonFetch(url)
    if (res.status === 404) return undefined
    if (!res.ok) throw new Error(`snapshot read answered ${res.status}`)
    const doc = new Loro()
    doc.import(new Uint8Array(await res.arrayBuffer()))
    return readLoadedFileDocument(doc)
  } catch (err) {
    log.warn('referenced document load failed', { ref, err })
    throw err
  }
}

export function createDaemonFileAdapter({
  daemonFetch,
  daemonBaseUrl,
  workspaceId,
  path,
  resolveRefPath,
}: DaemonFileAdapterOptions): DocumentFileAdapter {
  const fileUrl = (fileId: string) =>
    `${daemonBaseUrl}${documentFileApiUrl(workspaceId, path, fileId)}`

  async function loadImageBlob(ref: string): Promise<Blob | undefined> {
    try {
      return await readDaemonImage(daemonFetch, daemonBaseUrl, workspaceId, path, imageRefId(ref))
    } catch (err) {
      log.warn('image load failed', { ref, err })
      throw err
    }
  }

  return {
    // The file route keeps one directory per workspace, so the workspace is
    // the scope — on this daemon, which the base URL names.
    fileScope: `daemon:${daemonBaseUrl}/w/${workspaceId}`,
    isImageRef,

    loadDocument: (ref) =>
      loadSnapshotDocument(
        daemonFetch,
        `${daemonBaseUrl}${documentApiUrl(workspaceId, resolveRefPath?.(ref) ?? ref, 'snapshot')}`,
        ref,
      ),

    loadImageBlob,

    loadImageUrl: async (ref) => objectUrlOf(await loadImageBlob(ref)),

    async storeImage(file) {
      const id = crypto.randomUUID()
      try {
        const res = await daemonFetch(fileUrl(id), {
          method: 'PUT',
          // The route answers 415 for a Content-Type it has no extension
          // mapping for, so the picked file's own type has to travel.
          headers: { 'Content-Type': file.type },
          body: file,
        })
        if (!res.ok) {
          log.warn('image upload rejected', { status: res.status })
          return { ok: false, reason: uploadRefusalReason(res.status) }
        }
        return { ok: true, ref: newImageRef(id) }
      } catch (err) {
        log.warn('image upload failed', { err })
        return { ok: false, reason: 'Could not reach the daemon to store that image.' }
      }
    },
  }
}
