// Every daemon URL a client builds, other than the `/api/w/...` document
// family that lives beside its parser in document-url.ts. A client names a
// route here and nowhere else, so the route a typo would miss is found by
// the one test that requests each builder against the real app
// (mcp-server's `daemon-client-urls.routes.test.ts`).
//
// Each `/api` builder ends in `ApiUrl`: that suffix is how both that test and
// the keeper-parity scan in apps/web recognise a module that reaches the
// daemon. The `/auth` builders at the end are the one exception, and say why.
//
// Segments are encoded one by one; the separators between them are structure.
// Paths come back relative — the caller prefixes the daemon's base URL.
import {
  type SearchQueryInput,
  searchQueryString,
} from '@kamiazya/whiteboard-server-core/search-query'
import { encodeDocumentPath } from './document-url.js'

const enc = encodeURIComponent

export function workspacesApiUrl(): string {
  return '/api/workspaces'
}

/** One workspace, by id or by the handle its owner gave it. */
export function workspaceApiUrl(handle: string): string {
  return `${workspacesApiUrl()}/${enc(handle)}`
}

export function workspaceNamesApiUrl(workspaceId: string): string {
  return `${workspaceApiUrl(workspaceId)}/names`
}

/** The workspace's document list (GET) and legacy create (POST). */
export function workspaceDocumentsApiUrl(workspaceId: string): string {
  return `${workspaceApiUrl(workspaceId)}/documents`
}

// The `/api/workspaces/:workspaceId/documents/<document path>[/<suffix>]`
// family. The suffix is a closed set, written once below.
type DocumentsSuffix = '' | 'path' | 'name' | 'pin' | 'versions' | `versions/${string}`

function documentsFamilyUrl(workspaceId: string, path: string, suffix: DocumentsSuffix): string {
  const base = `${workspaceDocumentsApiUrl(workspaceId)}/${encodeDocumentPath(path)}`
  return suffix === '' ? base : `${base}/${suffix}`
}

/** DELETE a document and everything under it. */
export function documentRecordApiUrl(workspaceId: string, path: string): string {
  return documentsFamilyUrl(workspaceId, path, '')
}

export function documentPathApiUrl(workspaceId: string, path: string): string {
  return documentsFamilyUrl(workspaceId, path, 'path')
}

export function documentNameApiUrl(workspaceId: string, path: string): string {
  return documentsFamilyUrl(workspaceId, path, 'name')
}

export function documentPinApiUrl(workspaceId: string, path: string): string {
  return documentsFamilyUrl(workspaceId, path, 'pin')
}

export function documentVersionsApiUrl(workspaceId: string, path: string): string {
  return documentsFamilyUrl(workspaceId, path, 'versions')
}

// The version id is data, so it is encoded here — the one place that builds
// it — rather than by each caller.
export function versionDocumentApiUrl(
  workspaceId: string,
  path: string,
  versionId: string,
): string {
  return documentsFamilyUrl(workspaceId, path, `versions/${enc(versionId)}/document`)
}

export function versionRestoreApiUrl(workspaceId: string, path: string, versionId: string): string {
  return documentsFamilyUrl(workspaceId, path, `versions/${enc(versionId)}/restore`)
}

/** The workspace trash listing; restore appends /:documentId/restore. */
export function trashApiUrl(workspaceId: string): string {
  return `${workspaceApiUrl(workspaceId)}/trash`
}

/** One trash entry; DELETE destroys it permanently. */
export function trashEntryApiUrl(workspaceId: string, documentId: string): string {
  return `${trashApiUrl(workspaceId)}/${enc(documentId)}`
}

export function trashRestoreApiUrl(workspaceId: string, documentId: string): string {
  return `${trashApiUrl(workspaceId)}/${enc(documentId)}/restore`
}

// ---- maintenance, which sweeps one workspace at a time ----

export function optimizeAllApiUrl(workspaceId: string): string {
  return `${workspaceDocumentsApiUrl(workspaceId)}/optimize-all`
}

export function pruneSandwichedApiUrl(workspaceId: string): string {
  return `${workspaceApiUrl(workspaceId)}/versions/prune-sandwiched`
}

export function purgeDanglingApiUrl(workspaceId: string): string {
  return `${workspaceApiUrl(workspaceId)}/files/purge-dangling`
}

export function storageReportApiUrl(): string {
  return '/api/runtime/storage'
}

// ---- /api/v1: documents addressed by id ----

function v1WorkspaceUrl(workspaceId: string): string {
  return `/api/v1/workspaces/${enc(workspaceId)}`
}

export function documentsV1ApiUrl(workspaceId: string): string {
  return `${v1WorkspaceUrl(workspaceId)}/documents`
}

export function documentBacklinksApiUrl(workspaceId: string, documentId: string): string {
  return `${documentsV1ApiUrl(workspaceId)}/${enc(documentId)}/backlinks`
}

export function linkifyMentionsApiUrl(workspaceId: string, documentId: string): string {
  return `${documentsV1ApiUrl(workspaceId)}/${enc(documentId)}/linkify-mentions`
}

export function documentOkfApiUrl(workspaceId: string, documentId: string): string {
  return `${documentsV1ApiUrl(workspaceId)}/${enc(documentId)}/okf`
}

export function documentTagsApiUrl(workspaceId: string): string {
  return `${v1WorkspaceUrl(workspaceId)}/document-tags`
}

/** The query string comes from the route's own contract, so its names cannot drift from the parser's. */
export function searchApiUrl(workspaceId: string, input: SearchQueryInput): string {
  return `${v1WorkspaceUrl(workspaceId)}/search?${searchQueryString(input)}`
}

// ---- fonts ----

export function fontsApiUrl(): string {
  return '/api/fonts'
}

export function fontInstallApiUrl(fontId: string): string {
  return `${fontsApiUrl()}/${enc(fontId)}/install`
}

export function fontFileApiUrl(fontId: string): string {
  return `${fontsApiUrl()}/${enc(fontId)}/file`
}

// ---- /auth: the sign-in routes a server-mode keeper mounts (ADR-0046) ----
//
// Not `*ApiUrl`: that suffix marks a route the browser keeper must also
// answer, and these exist only on a server keeper, which has no browser-keeper
// twin. They are pinned the same way, against a server-mode app, by
// `daemon-client-urls.routes.test.ts`. A caller appends its own query string.

export function authProvidersUrl(): string {
  return '/auth/providers'
}

export function authSignInUrl(providerId: string): string {
  return `/auth/sign-in/${enc(providerId)}`
}

export function authSessionUrl(): string {
  return '/auth/session'
}

export function authSignOutUrl(): string {
  return '/auth/sign-out'
}

export function authReauthenticateUrl(): string {
  return '/auth/reauthenticate'
}
