import {
  apiErrorReason,
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
 * save or restore is the caller's signal to keep its dialog open.
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
}

/**
 * A refusal the daemon answered with a status, kept so a caller can log it.
 *
 * `reason` is the daemon's OWN display copy, read through `apiErrorReason` —
 * the only thing that tells a reader why a restore did not happen (`a document
 * already exists there`, and the rest of the route's { error, message }
 * family). It has to travel on the error because `safeErrorCopy` answers the
 * fallback for every `Error` by contract: a UI handed only this class would
 * say "try again" to a refusal that will never succeed.
 */
export class VersionsRequestError extends Error {
  readonly reason: string | undefined
  constructor(
    readonly status: number,
    what: string,
    reason?: string,
  ) {
    super(`${what} failed: ${status}`)
    this.name = 'VersionsRequestError'
    this.reason = reason
  }
}

/** The refusal the daemon authored for this response, if it authored one. */
async function refusalReason(res: Response): Promise<string | undefined> {
  return apiErrorReason(await res.json().catch(() => undefined))
}

// `documentsApiUrl` encodes the workspace and the path, and leaves the suffix
// to its caller — so the version id has to be encoded HERE, in the one place
// that builds it. It was encoded at exactly one call site before (the merge
// toast's own restore) and raw in all five of these, which is the shape a
// per-caller responsibility takes right before it is missed.
const versionUrl = (workspaceId: string, path: string, versionId: string, leaf: string): string =>
  documentsApiUrl(workspaceId, path, `versions/${encodeURIComponent(versionId)}/${leaf}`)

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
      const res = await fetchFn(versionUrl(workspaceId, path, versionId, 'document'))
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
      const res = await fetchFn(versionUrl(workspaceId, path, versionId, 'restore'), {
        method: 'POST',
      })
      if (!res.ok) {
        throw new VersionsRequestError(res.status, 'restore request', await refusalReason(res))
      }
    },
  }
}
