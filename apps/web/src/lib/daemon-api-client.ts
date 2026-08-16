import type { CanvasKind } from '@kamiazya/whiteboard-canvas-model'
import {
  apiErrorReason,
  type CanvasOkfV1Response,
  type CreateCanvasResponse,
  canvasApiUrl,
  canvasesApiUrl,
  canvasOkfV1ResponseSchema,
  createCanvasResponseSchema,
  type DeleteCanvasResponse,
  deleteCanvasResponseSchema,
  type ListCanvasesResponse,
  type ListCanvasesV1Response,
  type ListWorkspacesResponse,
  listCanvasesResponseSchema,
  listCanvasesV1ResponseSchema,
  listWorkspacesResponseSchema,
  type UpdateCanvasResponse,
  updateCanvasResponseSchema,
  type WorkspaceNames,
  workspaceNamesSchema,
} from '@kamiazya/whiteboard-mcp/api-contracts'
import { z } from 'zod'
// Re-exported so existing callers keep one import site; the implementation
// lives in its own module so a SharedWorker can use it without this file's
// schema graph.
import { createDaemonFetch } from './daemon-auth-fetch.js'

export { createDaemonFetch }

/** Thrown by `fetchAndParse` on a non-ok response, carrying the HTTP status
 *  so callers can branch on it (e.g. 404 vs. a real failure) instead of
 *  parsing the message string. */
export class DaemonApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'DaemonApiError'
    this.status = status
  }
}

async function parseProblemDetails(res: Response): Promise<string> {
  try {
    const reason = apiErrorReason(await res.json())
    if (reason !== undefined) return reason
  } catch {
    // fall through to the generic message below
  }
  return `Request failed (${res.status}).`
}

async function fetchAndParse<T>(
  fetchFn: typeof globalThis.fetch,
  url: string,
  schema: { parse: (input: unknown) => T },
  init?: RequestInit,
): Promise<T> {
  const res = await fetchFn(url, init)
  if (!res.ok) {
    throw new DaemonApiError(await parseProblemDetails(res), res.status)
  }
  const json = await res.json()
  try {
    return schema.parse(json)
  } catch {
    throw new Error('Response failed schema validation.')
  }
}

export function listWorkspaces(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
): Promise<ListWorkspacesResponse> {
  return fetchAndParse(fetchFn, `${daemonBaseUrl}/api/workspaces`, listWorkspacesResponseSchema)
}

export function listCanvases(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
): Promise<ListCanvasesResponse> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/canvases`,
    listCanvasesResponseSchema,
  )
}

export function createCanvas(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  slug: string,
  kind?: CanvasKind,
): Promise<CreateCanvasResponse> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/canvases`,
    createCanvasResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Omitted kind stays omitted (not null) so an older daemon that
      // rejects unknown fields never sees one it can't parse.
      body: JSON.stringify(kind === undefined ? { slug } : { slug, kind }),
    },
  )
}

export function deleteCanvas(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  slug: string,
): Promise<DeleteCanvasResponse> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}${canvasesApiUrl(workspaceId, slug)}`,
    deleteCanvasResponseSchema,
    { method: 'DELETE' },
  )
}

// GET /api/w/:workspaceId/canvas/:slug/snapshot returns raw Loro bytes
// (application/octet-stream), not JSON — kept separate from fetchAndParse,
// which always calls res.json().
export async function getCanvasSnapshot(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  slug: string,
): Promise<Uint8Array> {
  const url = `${daemonBaseUrl}${canvasApiUrl(workspaceId, slug, 'snapshot')}`
  const res = await fetchFn(url)
  if (!res.ok) {
    throw new Error(await parseProblemDetails(res))
  }
  return new Uint8Array(await res.arrayBuffer())
}

export function updateCanvas(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  slug: string,
  snapshot: Uint8Array,
): Promise<UpdateCanvasResponse> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}${canvasApiUrl(workspaceId, slug, 'update')}`,
    updateCanvasResponseSchema,
    { method: 'POST', body: snapshot as BodyInit },
  )
}

export function setCanvasName(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  slug: string,
  name: string,
): Promise<WorkspaceNames> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}${canvasesApiUrl(workspaceId, slug, 'name')}`,
    workspaceNamesSchema,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    },
  )
}

// ---- OpenCanvas /api/v1 surface (canvasId + derived alias world) ----

export function listCanvasesV1(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
): Promise<ListCanvasesV1Response> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/canvases`,
    listCanvasesV1ResponseSchema,
  )
}

export function getCanvasOkfV1(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  canvasId: string,
): Promise<CanvasOkfV1Response> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/canvases/${encodeURIComponent(canvasId)}/okf`,
    canvasOkfV1ResponseSchema,
  )
}

// ---- pairing-grant flow (daemon-origin consent page) ----

const createPairingGrantResponseSchema = z
  .object({ grantId: z.string(), origin: z.string(), code: z.string() })
  .strict()
export type CreatePairingGrantResponse = z.infer<typeof createPairingGrantResponseSchema>

/** Same-origin call from the daemon-served /pair page; the daemon token is
 *  the R3-injected one. The credential goes through createDaemonFetch rather
 *  than an inline header so the seam stays a single function, not a whole
 *  module — a SharedWorker can then reuse it without importing this file. */
export async function createPairingGrant(
  fetchFn: typeof globalThis.fetch,
  daemonToken: string,
  input: { origin: string; codeChallenge: string },
): Promise<CreatePairingGrantResponse> {
  // Same-origin by construction: this page is served by the daemon, so its own
  // origin IS the daemon origin and createDaemonFetch's origin check passes.
  const authed = createDaemonFetch(globalThis.location.origin, daemonToken, fetchFn)
  const res = await authed('/api/pairing/grants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    throw new Error(`grant request failed (${res.status})`)
  }
  return createPairingGrantResponseSchema.parse(await res.json())
}
