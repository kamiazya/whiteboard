import {
  documentVersionsApiUrl,
  documentVersionsPageApiUrl,
  listVersionsResponseSchema,
  type saveVersionRequestSchema,
  saveVersionResponseSchema,
  type VersionEntry,
  versionDocumentApiUrl,
  versionDocumentResponseSchema,
  versionRestoreApiUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { refusalReasonOf } from '@kamiazya/whiteboard-daemon-client/api-contracts/refusal-reason'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { z } from 'zod'
import { readDaemonJson } from './daemon-contract-error.js'

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
 * `reason` is the daemon's OWN display copy, read through `refusalReasonOf` —
 * the only thing that tells a reader why a restore did not happen (`a document
 * already exists there`, and the rest of the route's { error, message }
 * family), and absent when the daemon gave none. It has to travel on the
 * error because the UI's fallback copy answers every `Error` the same way: a
 * UI handed only this class would say "try again" to a refusal that will
 * never succeed.
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

/**
 * A document's whole history, read a page at a time. The daemon answers a
 * list in pages; the panel shows the whole history, so every page is read. A
 * document's history is bounded — its automatic checkpoints are capped and
 * its manual saves have a ceiling — so this is a handful of requests, not an
 * open-ended walk.
 */
async function listEveryPage(
  fetchFn: typeof globalThis.fetch,
  workspaceId: string,
  path: string,
): Promise<VersionEntry[]> {
  const versions: VersionEntry[] = []
  let cursor: string | undefined
  do {
    const url = documentVersionsPageApiUrl(
      workspaceId,
      path,
      cursor === undefined ? {} : { cursor },
    )
    const res = await fetchFn(url)
    if (!res.ok) throw new VersionsRequestError(res.status, 'versions request')
    const page = await readDaemonJson(url, res, listVersionsResponseSchema)
    versions.push(...page.versions)
    // A cursor repeated would read the same page forever.
    cursor = page.nextCursor === cursor ? undefined : page.nextCursor
  } while (cursor !== undefined)
  return versions
}

/** The daemon's history, over its documents routes. */
export function createDaemonVersionsBackend(fetchFn: typeof globalThis.fetch): VersionsBackend {
  return {
    list: (workspaceId, path) => listEveryPage(fetchFn, workspaceId, path),
    async loadPast(workspaceId, path, versionId) {
      const url = versionDocumentApiUrl(workspaceId, path, versionId)
      const res = await fetchFn(url)
      if (res.status === 404) return null
      if (!res.ok) throw new VersionsRequestError(res.status, 'version document request')
      return readDaemonJson(url, res, versionDocumentResponseSchema)
    },
    async save(workspaceId, path, { label }) {
      const url = documentVersionsApiUrl(workspaceId, path)
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label } satisfies z.infer<typeof saveVersionRequestSchema>),
      })
      if (!res.ok) {
        // The daemon's own reason, so a refusal that will always repeat — a
        // document at its version ceiling — is not answered with "try again".
        const { reason } = await refusalReasonOf(res, '')
        throw new VersionsRequestError(res.status, 'save version', reason || undefined)
      }
      return (await readDaemonJson(url, res, saveVersionResponseSchema)).version
    },
    async restore(workspaceId, path, versionId) {
      const res = await fetchFn(versionRestoreApiUrl(workspaceId, path, versionId), {
        method: 'POST',
      })
      if (!res.ok) {
        // An empty fallback, so a refusal that says nothing carries no reason
        // and the UI keeps its own wording rather than quoting a status line.
        const { reason } = await refusalReasonOf(res, '')
        throw new VersionsRequestError(res.status, 'restore request', reason || undefined)
      }
    },
  }
}
