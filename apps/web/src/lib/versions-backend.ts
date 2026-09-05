import {
  documentsApiUrl,
  listVersionsResponseSchema,
  saveVersionResponseSchema,
  type VersionEntry,
  versionDocumentResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'

/**
 * A document's version history as the UI reads and writes it — the seam
 * between the History panel / save controls and whoever KEEPS the
 * workspace. The daemon answers over its HTTP routes; the browser keeper
 * answers from its own IndexedDB store. Either way the panel sees the same
 * rows (`VersionEntry`, declared once in server-core) and performs the same
 * three acts.
 *
 * `path`-addressed like the routes are, because a version belongs to a
 * document at the name it had. Every method throws on failure — a rejected
 * save or restore is the caller's signal to keep its dialog open — and
 * `putThumbnail` is absent where the keeper renders none.
 */
/**
 * A past state, as the panel PREVIEWS it before deciding to restore.
 *
 * A projected value rather than a CRDT document: what a preview needs is
 * something to draw, and these are the two shapes every surface that draws
 * a document already speaks. It also keeps the seam free of Loro types, so
 * a keeper that never held one could still answer.
 */
export type PastDocument =
  | { readonly kind: 'spatial'; readonly canvas: SpatialCanvas }
  | { readonly kind: 'markdown'; readonly body: string }

export interface VersionsBackend {
  list(workspaceId: string, path: string): Promise<VersionEntry[]>
  /**
   * What one version holds, for looking at it before applying it. `null` for
   * a version this document does not own — the refusal restore makes, for
   * the same reason: an id alone must not read another document's history.
   */
  loadPast(workspaceId: string, path: string, versionId: string): Promise<PastDocument | null>
  save(workspaceId: string, path: string, input: { label: string }): Promise<VersionEntry>
  restore(workspaceId: string, path: string, versionId: string): Promise<void>
  /**
   * Keep the picture drawn for a saved point. Not optional, and neither is
   * its reader: a keeper that drew none was the difference nobody declared —
   * the panel asked the daemon's route directly, so the same row in the
   * browser had nowhere to get a picture from and simply showed less.
   */
  putThumbnail(workspaceId: string, path: string, versionId: string, blob: Blob): Promise<void>
  /** The picture, or `null` for a point that has none — and for one this document does not own. */
  loadThumbnail(workspaceId: string, path: string, versionId: string): Promise<Blob | null>
}

/** A refusal the daemon answered with a status, kept so a caller can log it. */
export class VersionsRequestError extends Error {
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(`${what} failed: ${status}`)
    this.name = 'VersionsRequestError'
  }
}

/** The daemon's history, over its documents routes. */
export function createDaemonVersionsBackend(fetchFn: typeof globalThis.fetch): VersionsBackend {
  return {
    async list(workspaceId, path) {
      const res = await fetchFn(documentsApiUrl(workspaceId, path, 'versions'))
      if (!res.ok) throw new VersionsRequestError(res.status, 'versions request')
      const parsed = listVersionsResponseSchema.safeParse(await res.json())
      if (!parsed.success) throw new Error('versions response failed schema validation')
      return parsed.data.versions
    },
    async loadPast(workspaceId, path, versionId) {
      const res = await fetchFn(
        documentsApiUrl(workspaceId, path, `versions/${versionId}/document`),
      )
      if (res.status === 404) return null
      if (!res.ok) throw new VersionsRequestError(res.status, 'version document request')
      const parsed = versionDocumentResponseSchema.safeParse(await res.json())
      if (!parsed.success) throw new Error('version document response failed schema validation')
      return parsed.data
    },
    async save(workspaceId, path, { label }) {
      const res = await fetchFn(documentsApiUrl(workspaceId, path, 'versions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      })
      if (!res.ok) throw new VersionsRequestError(res.status, 'save version')
      const parsed = saveVersionResponseSchema.safeParse(await res.json().catch(() => null))
      if (!parsed.success) throw new Error('POST /versions response did not match schema')
      return parsed.data.version
    },
    async restore(workspaceId, path, versionId) {
      const res = await fetchFn(
        documentsApiUrl(workspaceId, path, `versions/${versionId}/restore`),
        {
          method: 'POST',
        },
      )
      if (!res.ok) throw new VersionsRequestError(res.status, 'restore request')
    },
    async loadThumbnail(workspaceId, path, versionId) {
      const res = await fetchFn(
        documentsApiUrl(workspaceId, path, `versions/${versionId}/thumbnail`),
      )
      // 404 is "not this document's, or no such point".
      if (res.status === 404) return null
      if (!res.ok) throw new VersionsRequestError(res.status, 'thumbnail request')
      const blob = await res.blob()
      // An empty body is the same answer as a 404 — there is no picture —
      // and it must not become a zero-byte object URL, which renders as a
      // broken image rather than as nothing. This is also how the daemon's
      // "none yet" arrives: 204 is a SUCCESS status that slips past `res.ok`,
      // and it carries no body, so it needs no branch of its own. Measured:
      // with only a `status === 204` check the empty-200 case fails; with
      // only this one both pass.
      return blob.size === 0 ? null : blob
    },
    async putThumbnail(workspaceId, path, versionId, blob) {
      const res = await fetchFn(
        documentsApiUrl(workspaceId, path, `versions/${versionId}/thumbnail`),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'image/png' },
          body: blob,
        },
      )
      // A fetch RESOLVES for 4xx and 5xx, so without this the daemon
      // refusing the upload is indistinguishable from it accepting one, and
      // the caller's failure path is unreachable by anything but a network
      // error.
      if (!res.ok) throw new VersionsRequestError(res.status, 'thumbnail upload')
    },
  }
}
