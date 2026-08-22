import {
  apiErrorReason,
  type CreateDocumentResponse,
  createDocumentResponseSchema,
  createGrantResponseSchema,
  type DeleteDocumentResponse,
  type DocumentBacklinksResponse,
  type DocumentOkfV1Response,
  deleteDocumentResponseSchema,
  documentApiUrl,
  documentBacklinksResponseSchema,
  documentOkfV1ResponseSchema,
  documentsApiUrl,
  type InstallFontResponse,
  installFontResponseSchema,
  type ListDocumentsResponse,
  type ListFontsResponse,
  type ListWorkspacesResponse,
  listDocumentsResponseSchema,
  listFontsResponseSchema,
  listWorkspacesResponseSchema,
  type RenameDocumentPathRequest,
  type RenameDocumentPathResponse,
  renameDocumentPathResponseSchema,
  type UpdateDocumentResponse,
  updateDocumentResponseSchema,
  type WorkspaceDocumentTagsResponse,
  type WorkspaceNames,
  workspaceDocumentTagsResponseSchema,
  workspaceNamesSchema,
} from '@kamiazya/whiteboard-mcp/api-contracts'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { z } from 'zod'
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

export function listDocuments(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
): Promise<ListDocumentsResponse> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/documents`,
    listDocumentsResponseSchema,
  )
}

export function createDocument(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  path: string,
  kind?: DocumentKind,
): Promise<CreateDocumentResponse> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/documents`,
    createDocumentResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Omitted kind stays omitted (not null) so an older daemon that
      // rejects unknown fields never sees one it can't parse.
      body: JSON.stringify(kind === undefined ? { path } : { path, kind }),
    },
  )
}

/**
 * Move a document, and everything under it, to a new path.
 *
 * The path being MOVED addresses the request and the destination travels in
 * the body: putting the new one in the URL would address a document that
 * does not exist yet. The store plans the whole subtree, so a 409 names the
 * PRODUCED path that collided — often not the one the caller asked for,
 * which is why callers must show the server's message rather than rebuild
 * one around `newPath`.
 */
export function renameDocumentPath(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  path: string,
  newPath: string,
): Promise<RenameDocumentPathResponse> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}${documentsApiUrl(workspaceId, path, 'path')}`,
    renameDocumentPathResponseSchema,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: newPath } satisfies RenameDocumentPathRequest),
    },
  )
}

export function deleteDocument(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  path: string,
): Promise<DeleteDocumentResponse> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}${documentsApiUrl(workspaceId, path)}`,
    deleteDocumentResponseSchema,
    { method: 'DELETE' },
  )
}

// GET /api/w/:workspaceId/document/:path/snapshot returns raw Loro bytes
// (application/octet-stream), not JSON — kept separate from fetchAndParse,
// which always calls res.json().
export async function getDocumentSnapshot(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  path: string,
): Promise<Uint8Array> {
  const url = `${daemonBaseUrl}${documentApiUrl(workspaceId, path, 'snapshot')}`
  const res = await fetchFn(url)
  if (!res.ok) {
    throw new Error(await parseProblemDetails(res))
  }
  return new Uint8Array(await res.arrayBuffer())
}

export function updateDocument(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  path: string,
  snapshot: Uint8Array,
): Promise<UpdateDocumentResponse> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}${documentApiUrl(workspaceId, path, 'update')}`,
    updateDocumentResponseSchema,
    { method: 'POST', body: snapshot as BodyInit },
  )
}

export function getWorkspaceNames(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
): Promise<WorkspaceNames> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/names`,
    workspaceNamesSchema,
  )
}

export function setDocumentDisplayName(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  path: string,
  name: string,
): Promise<WorkspaceNames> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}${documentsApiUrl(workspaceId, path, 'name')}`,
    workspaceNamesSchema,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    },
  )
}

// ---- /api/v1 document surface (documentId + derived alias world) ----

/** Documents in this workspace that reference `documentId` (the Connections panel). */
export function getDocumentBacklinks(
  fetchImpl: typeof fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  documentId: string,
): Promise<DocumentBacklinksResponse> {
  return fetchAndParse(
    fetchImpl,
    `${daemonBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(documentId)}/backlinks`,
    documentBacklinksResponseSchema,
  )
}

/** The workspace's tag projection (documentId -> tags), for the document browser. */
export function getWorkspaceDocumentTags(
  fetchImpl: typeof fetch,
  daemonBaseUrl: string,
  workspaceId: string,
): Promise<WorkspaceDocumentTagsResponse> {
  return fetchAndParse(
    fetchImpl,
    `${daemonBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/document-tags`,
    workspaceDocumentTagsResponseSchema,
  )
}

export function getDocumentOkfV1(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  documentId: string,
): Promise<DocumentOkfV1Response> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(documentId)}/okf`,
    documentOkfV1ResponseSchema,
  )
}

// ---- fonts (ADR-0012: the daemon keeps what it renders with) ----

export function listFonts(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
): Promise<ListFontsResponse> {
  return fetchAndParse(fetchFn, `${daemonBaseUrl}/api/fonts`, listFontsResponseSchema)
}

/**
 * Install one catalogued font.
 *
 * The argument is a catalogue id and there is deliberately no URL variant:
 * the daemon builds the request from a pinned template, so no caller — this
 * one, or an agent that talked one into it — can choose where it reaches.
 */
export function installFont(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  fontId: string,
): Promise<InstallFontResponse> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}/api/fonts/${encodeURIComponent(fontId)}/install`,
    installFontResponseSchema,
    { method: 'POST' },
  )
}

// ---- pairing-grant flow (daemon-origin consent page) ----

export type CreatePairingGrantResponse = z.infer<typeof createGrantResponseSchema>

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
  return createGrantResponseSchema.parse(await res.json())
}
