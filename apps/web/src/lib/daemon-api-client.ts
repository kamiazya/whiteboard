import {
  createDocumentV1ResponseSchema,
  type createWorkspaceRequestSchema,
  type DeleteDocumentResponse,
  type DocumentBacklinksResponse,
  type DocumentOkfV1Response,
  type DocumentSearchResponse,
  deleteDocumentResponseSchema,
  documentApiUrl,
  documentBacklinksApiUrl,
  documentBacklinksResponseSchema,
  documentNameApiUrl,
  documentOkfApiUrl,
  documentOkfV1ResponseSchema,
  documentPathApiUrl,
  documentPinApiUrl,
  documentRecordApiUrl,
  documentSearchResponseSchema,
  documentsV1ApiUrl,
  documentTagsApiUrl,
  fontFileApiUrl,
  fontInstallApiUrl,
  fontsApiUrl,
  type InstallFontResponse,
  installFontResponseSchema,
  type LinkifyMentionsResponse,
  type ListDocumentsResponse,
  type ListFontsResponse,
  type ListTrashResponse,
  type ListWorkspacesResponse,
  linkifyMentionsApiUrl,
  linkifyMentionsResponseSchema,
  listDocumentsResponseSchema,
  listFontsResponseSchema,
  listTrashResponseSchema,
  listWorkspacesResponseSchema,
  type RenameDocumentPathRequest,
  type RenameDocumentPathResponse,
  type RenameWorkspaceRequest,
  type RestoreTrashResponse,
  renameDocumentPathResponseSchema,
  restoreTrashResponseSchema,
  searchApiUrl,
  type setNameRequestSchema,
  type setPinnedRequestSchema,
  trashApiUrl,
  trashRestoreApiUrl,
  type UpdateDocumentResponse,
  updateDocumentResponseSchema,
  type WorkspaceDocumentTagsResponse,
  type WorkspaceNames,
  type WorkspaceSummary,
  workspaceApiUrl,
  workspaceDocumentsApiUrl,
  workspaceDocumentTagsResponseSchema,
  workspaceNamesApiUrl,
  workspaceNamesSchema,
  workspaceSummarySchema,
  workspacesApiUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { refusalReasonOf } from '@kamiazya/whiteboard-daemon-client/api-contracts/refusal-reason'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { z } from 'zod'
// Re-exported so existing callers keep one import site; the implementation
// lives in its own module so a SharedWorker can use it without this file's
// schema graph.
import { createDaemonFetch } from './daemon-auth-fetch.js'

export { createDaemonFetch }

/** Thrown by `fetchAndParse` on a non-ok response, carrying the HTTP status
 *  so callers can branch on it (e.g. 404 vs. a real failure) instead of
 *  parsing the message string. `body` is the parsed JSON of the response
 *  (undefined when the body was not JSON) — the seam a typed refusal (e.g.
 *  `membershipRefusalSchema`) is read back through, by CODE rather than by
 *  matching the message sentence. */
export class DaemonApiError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(message: string, status: number, body?: unknown) {
    super(message)
    this.name = 'DaemonApiError'
    this.status = status
    this.body = body
  }
}

async function parseProblemDetails(res: Response): Promise<{ message: string; body: unknown }> {
  const { reason, body } = await refusalReasonOf(res, `Request failed (${res.status}).`)
  return { message: reason, body }
}

async function fetchAndParse<T>(
  fetchFn: typeof globalThis.fetch,
  url: string,
  schema: { parse: (input: unknown) => T },
  init?: RequestInit,
): Promise<T> {
  const res = await fetchFn(url, init)
  if (!res.ok) {
    const { message, body } = await parseProblemDetails(res)
    throw new DaemonApiError(message, res.status, body)
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
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}${workspacesApiUrl()}`,
    listWorkspacesResponseSchema,
  )
}

/**
 * Create a workspace the daemon keeps.
 *
 * Takes a DISPLAY NAME and nothing else, because the other two of ADR-0019's
 * layers are the server's: it mints the canonical id and derives the segment.
 * That is what lets one switcher control call `create(displayName)` without
 * knowing which keeper is answering.
 */
export function createWorkspace(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  displayName: string,
): Promise<WorkspaceSummary> {
  return fetchAndParse(fetchFn, `${daemonBaseUrl}${workspacesApiUrl()}`, workspaceSummarySchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName } satisfies z.infer<typeof createWorkspaceRequestSchema>),
  })
}

/**
 * Rename the two layers a workspace's owner chooses.
 *
 * PATCH, and a field left out is left ALONE — never cleared. The caller passes
 * only what it is changing, which is why the switcher can write the name and
 * the address independently instead of submitting one form that would put
 * every name edit behind the write that can be refused for a collision.
 */
export function renameWorkspace(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  handle: string,
  input: RenameWorkspaceRequest,
): Promise<WorkspaceSummary> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}${workspaceApiUrl(handle)}`,
    workspaceSummarySchema,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  )
}

export function listDocuments(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
): Promise<ListDocumentsResponse> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}${workspaceDocumentsApiUrl(workspaceId)}`,
    listDocumentsResponseSchema,
  )
}

/**
 * `/api/v1`, not the legacy arm. Same operation the `wb_document_create` MCP
 * tool runs, through the same schema, so the daemon answers one create rather
 * than two that drift — and the answer carries the id the server minted and
 * the workspace it filed under, where the legacy body said only `path`.
 *
 * `kind` is REQUIRED here because v1's input is a discriminated union on it.
 * It was optional before, and two callers relied on that: the legacy route's
 * request schema carried `.default('spatial')`, so a body of `{ path }` alone
 * created a canvas. Those callers now say `'spatial'` themselves, which is
 * the same document and a default nobody has to go and look up.
 */
export function createDocument(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  path: string,
  kind: DocumentKind,
  name?: string,
): Promise<z.infer<typeof createDocumentV1ResponseSchema>> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}${documentsV1ApiUrl(workspaceId)}`,
    createDocumentV1ResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `name` stays omitted rather than null: v1's input is `.strict()` and
      // the field is optional, so a null would be refused outright.
      body: JSON.stringify({ path, kind, ...(name === undefined ? {} : { name }) }),
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
    `${daemonBaseUrl}${documentPathApiUrl(workspaceId, path)}`,
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
    `${daemonBaseUrl}${documentRecordApiUrl(workspaceId, path)}`,
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
    throw new Error((await parseProblemDetails(res)).message)
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
    `${daemonBaseUrl}${workspaceNamesApiUrl(workspaceId)}`,
    workspaceNamesSchema,
  )
}

export function listTrash(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
): Promise<ListTrashResponse> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}${trashApiUrl(workspaceId)}`,
    listTrashResponseSchema,
  )
}

export function restoreFromTrash(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  documentId: string,
): Promise<RestoreTrashResponse> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}${trashRestoreApiUrl(workspaceId, documentId)}`,
    restoreTrashResponseSchema,
    { method: 'POST' },
  )
}

export function setDocumentPinned(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  path: string,
  pinned: boolean,
): Promise<WorkspaceNames> {
  return fetchAndParse(
    fetchFn,
    `${daemonBaseUrl}${documentPinApiUrl(workspaceId, path)}`,
    workspaceNamesSchema,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned } satisfies z.infer<typeof setPinnedRequestSchema>),
    },
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
    `${daemonBaseUrl}${documentNameApiUrl(workspaceId, path)}`,
    workspaceNamesSchema,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name } satisfies z.infer<typeof setNameRequestSchema>),
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
    `${daemonBaseUrl}${documentBacklinksApiUrl(workspaceId, documentId)}`,
    documentBacklinksResponseSchema,
  )
}

/** Content search across a workspace — bodies and canvas text, not only names. */
export function searchWorkspaceDocuments(
  fetchImpl: typeof fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  query: string,
  limit: number,
): Promise<DocumentSearchResponse> {
  return fetchAndParse(
    fetchImpl,
    `${daemonBaseUrl}${searchApiUrl(workspaceId, { query, limit })}`,
    documentSearchResponseSchema,
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
    `${daemonBaseUrl}${documentTagsApiUrl(workspaceId)}`,
    workspaceDocumentTagsResponseSchema,
  )
}

/** Convert a source document's unlinked mentions of the target into [[...]] links. */
export function linkifyDocumentMentions(
  fetchImpl: typeof fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  sourceDocumentId: string,
  targetDocumentId: string,
): Promise<LinkifyMentionsResponse> {
  return fetchAndParse(
    fetchImpl,
    `${daemonBaseUrl}${linkifyMentionsApiUrl(workspaceId, sourceDocumentId)}`,
    linkifyMentionsResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetDocumentId }),
    },
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
    `${daemonBaseUrl}${documentOkfApiUrl(workspaceId, documentId)}`,
    documentOkfV1ResponseSchema,
  )
}

// ---- fonts (ADR-0012: the daemon keeps what it renders with) ----

export function listFonts(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
): Promise<ListFontsResponse> {
  return fetchAndParse(fetchFn, `${daemonBaseUrl}${fontsApiUrl()}`, listFontsResponseSchema)
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
    `${daemonBaseUrl}${fontInstallApiUrl(fontId)}`,
    installFontResponseSchema,
    { method: 'POST' },
  )
}

/**
 * The bytes of an installed font, so this realm can register the face the
 * daemon exports with (ADR-0012 decision 4's browser half).
 */
export async function fetchFontFile(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  fontId: string,
): Promise<ArrayBuffer> {
  const res = await fetchFn(`${daemonBaseUrl}${fontFileApiUrl(fontId)}`)
  if (!res.ok) {
    const { message, body } = await parseProblemDetails(res)
    throw new DaemonApiError(message, res.status, body)
  }
  return await res.arrayBuffer()
}
