import {
  documentsApiUrl,
  listVersionsResponseSchema,
  saveVersionResponseSchema,
  type VersionEntry,
} from '@kamiazya/whiteboard-mcp/api-contracts'

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
export interface VersionsBackend {
  list(workspaceId: string, path: string): Promise<VersionEntry[]>
  save(workspaceId: string, path: string, input: { label: string }): Promise<VersionEntry>
  restore(workspaceId: string, path: string, versionId: string): Promise<void>
  putThumbnail?(workspaceId: string, path: string, versionId: string, blob: Blob): Promise<void>
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
    async putThumbnail(workspaceId, path, versionId, blob) {
      await fetchFn(documentsApiUrl(workspaceId, path, `versions/${versionId}/thumbnail`), {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: blob,
      })
    },
  }
}
