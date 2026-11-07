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
  documentByIdApiUrl,
  documentFileByIdApiUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document-url'
import { imageRefId, isImageRef, newImageRef } from '@kamiazya/whiteboard-model'
import { Loro } from 'loro-crdt'
import { getAppLogger } from './app-logger.js'
import { readDaemonImage } from './daemon-image-read.js'
import type { DocumentFileAdapter, LoadedFileDocument } from './document-file-contract.js'
import { uploadRefusalReason } from './image-upload-policy.js'
import { readLoadedFileDocument } from './read-loaded-file-document.js'

const log = getAppLogger('daemon-file-adapter')

const NO_OPEN_DOCUMENT = 'no document is open to address files under'
const NO_OPEN_DOCUMENT_REASON = 'no document is open to keep that picture under'

export interface DaemonFileAdapterOptions {
  readonly daemonFetch: typeof fetch
  readonly daemonBaseUrl: string
  readonly workspaceId: string
  /**
   * The open document the files are kept under. `undefined` means no document
   * is open: every read and write then refuses without a request, so an
   * address with an empty id can never be built.
   */
  readonly documentId: string | undefined
  /**
   * Maps a file node's ref to the id of the document it names (undefined when
   * the ref names no listed document, which answers an absent document with no
   * request). Refs are resolved by LOOKUP, never by format: the id alphabet
   * overlaps the path charset, so a legacy path ref is looked up too.
   */
  readonly resolveRefId?: (ref: string) => string | undefined
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

/**
 * What one PUT of the daemon's file route came to, worded for the person:
 * `status` when the daemon answered and refused, `error` when it could not be
 * reached.
 */
export type DaemonImagePut =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly status: number }
  | {
      readonly ok: false
      readonly reason: string
      readonly status?: undefined
      readonly error: unknown
    }

/**
 * The one writer of the file route, shared by the daemon keeper's image seam
 * and the workspace move, so a refusal reads the same from both. It never
 * throws and logs nothing: the move reports its outcomes as a list, the seam
 * as a log line.
 */
export async function putDaemonImage(
  daemonFetch: typeof fetch,
  url: string,
  image: Blob,
  contentType: string,
): Promise<DaemonImagePut> {
  try {
    const res = await daemonFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: image,
    })
    if (res.ok) return { ok: true }
    return { ok: false, reason: uploadRefusalReason(res.status), status: res.status }
  } catch (error) {
    return { ok: false, reason: 'Could not reach the daemon to store that image.', error }
  }
}

/**
 * One upload through the file route. An address that cannot be built (no
 * document open) answers a refusal without a request, like any rejected
 * upload: the person is told, and nothing reaches the daemon.
 */
async function storeDaemonImage(
  daemonFetch: typeof fetch,
  urlFor: (fileId: string) => string,
  file: File,
): ReturnType<DocumentFileAdapter['storeImage']> {
  const id = crypto.randomUUID()
  let url: string
  try {
    url = urlFor(id)
  } catch {
    return { ok: false, reason: NO_OPEN_DOCUMENT_REASON }
  }
  // The route answers 415 for a Content-Type it has no extension
  // mapping for, so the picked file's own type has to travel.
  const put = await putDaemonImage(daemonFetch, url, file, file.type)
  if (put.ok) return { ok: true, ref: newImageRef(id) }
  if (put.status === undefined) log.warn('image upload failed', { err: put.error })
  else log.warn('image upload rejected', { status: put.status })
  return { ok: false, reason: put.reason }
}

export function createDaemonFileAdapter({
  daemonFetch,
  daemonBaseUrl,
  workspaceId,
  documentId,
  resolveRefId,
}: DaemonFileAdapterOptions): DocumentFileAdapter {
  const addressed = (): string => {
    if (documentId === undefined) throw new Error(NO_OPEN_DOCUMENT)
    return documentId
  }
  const fileUrl = (fileId: string) =>
    `${daemonBaseUrl}${documentFileByIdApiUrl(workspaceId, addressed(), fileId)}`

  async function loadImageBlob(ref: string): Promise<Blob | undefined> {
    try {
      return await readDaemonImage(
        daemonFetch,
        daemonBaseUrl,
        workspaceId,
        addressed(),
        imageRefId(ref),
      )
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

    loadDocument: (ref) => {
      const id = resolveRefId?.(ref)
      if (id === undefined) return Promise.resolve(undefined)
      const url = `${daemonBaseUrl}${documentByIdApiUrl(workspaceId, id, 'snapshot')}`
      return loadSnapshotDocument(daemonFetch, url, ref)
    },

    loadImageBlob,

    loadImageUrl: async (ref) => objectUrlOf(await loadImageBlob(ref)),

    storeImage: (file) => storeDaemonImage(daemonFetch, fileUrl, file),
  }
}
