// Every daemon URL a client builds, other than the `/api/w/...` document
// family that lives beside its parser in document-url.ts. A client names a
// route here and nowhere else, so the route a typo would miss is found by
// the one test that requests each builder against the real app
// (mcp-server's `daemon-client-urls.routes.test.ts`).
//
// Each `/api` builder ends in `ApiUrl`: that suffix is how both that test and
// the keeper-parity scan in apps/web recognise a module that reaches the
// daemon. The `/auth` builders at the end are the one exception, and say why.
// tools/arch-lint's `daemon-route-literals.test.ts` fails a client module that
// spells an `/api/` or `/auth/` path itself instead of calling a builder here.
//
// Segments are encoded one by one; the separators between them are structure.
// Paths come back relative — the caller prefixes the daemon's base URL.
import {
  type SearchQueryInput,
  searchQueryString,
} from '@kamiazya/whiteboard-server-core/search-query'
import { encodeDocumentPath } from './document-url.js'
import type { SignInRefusal } from './sign-in.js'

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
type DocumentsSuffix =
  | ''
  | 'path'
  | 'name'
  | 'pin'
  | 'duplicate'
  | 'versions'
  | `versions/${string}`

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

/** POST: copy the document, beside itself, in one keeper-side write. */
export function documentDuplicateApiUrl(workspaceId: string, path: string): string {
  return documentsFamilyUrl(workspaceId, path, 'duplicate')
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

/** The cheapest authenticated answer a daemon gives: "something is listening, and lets you in". */
export function runtimePingApiUrl(): string {
  return '/api/runtime/ping'
}

// ---- sync: the SSE stream and the two control posts beside it ----

/** GET: the one long-lived event stream a page's sync hub reads. */
export function syncStreamApiUrl(): string {
  return '/api/sync/stream'
}

/** POST: route documents into (or out of) an open stream. */
export function syncSubscribeApiUrl(): string {
  return '/api/sync/subscribe'
}

/** POST: a client's update or awareness frame, addressed to its stream. */
export function syncMessageApiUrl(): string {
  return '/api/sync/message'
}

/** The daemon's own health and configuration, as `whiteboard server doctor` reads it. */
export function runtimeStatusApiUrl(): string {
  return '/api/runtime/status'
}

/** POST: the workspace key an offline replica is sealed with (ADR-0042). */
export function replicaKeyApiUrl(workspaceId: string): string {
  return `${workspaceApiUrl(workspaceId)}/replica-key`
}

/** POST: replace the workspace's replica key, so a replica sealed with the old one cannot open. */
export function replicaKeyRotateApiUrl(workspaceId: string): string {
  return `${replicaKeyApiUrl(workspaceId)}/rotate`
}

/** PUT: whether the workspace hands out replica keys at all (ADR-0042). */
export function replicaTierApiUrl(workspaceId: string): string {
  return `${workspaceApiUrl(workspaceId)}/replica-tier`
}

// ---- people: mounted only by a server-mode keeper (ADR-0049) ----

/** A tenant's users, as its administrators manage them. */
export function tenantPeopleApiUrl(): string {
  return '/api/people'
}

/** DELETE: remove a user from the tenant. */
export function tenantPersonApiUrl(userId: string): string {
  return `${tenantPeopleApiUrl()}/${enc(userId)}`
}

/** POST deactivates, DELETE reactivates. */
export function tenantPersonDeactivationApiUrl(userId: string): string {
  return `${tenantPersonApiUrl(userId)}/deactivation`
}

/** PUT appoints, DELETE dismisses. */
export function tenantPersonAdministratorApiUrl(userId: string): string {
  return `${tenantPersonApiUrl(userId)}/administrator`
}

/** POST: an invitation link into the tenant. */
export function tenantInvitationsApiUrl(): string {
  return '/api/invitations'
}

/** A workspace's people, as its owners manage them. */
export function workspacePeopleApiUrl(workspaceId: string): string {
  return `${workspaceApiUrl(workspaceId)}/people`
}

/** PATCH changes the role, DELETE removes the person from the workspace. */
export function workspacePersonApiUrl(workspaceId: string, userId: string): string {
  return `${workspacePeopleApiUrl(workspaceId)}/${enc(userId)}`
}

/** POST: an invitation link into the workspace. */
export function workspaceInvitationsApiUrl(workspaceId: string): string {
  return `${workspaceApiUrl(workspaceId)}/invitations`
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
// Not `*ApiUrl`: these sit outside `/api`, and the keeper-parity scan
// recognises them by their own `auth*Url` spelling. They are pinned the same
// way as the people builders, against a server-mode app, by
// `daemon-client-urls.routes.test.ts`. The query a sign-in carries is built
// and read here, by the web app and the keeper alike, so a key cannot be
// spelled differently on the two sides.

/** The names a sign-in's query string carries, keyed by the field each one is. */
const SIGN_IN_QUERY_PARAMS = {
  returnTo: 'return',
  invitation: 'invitation',
} as const

/**
 * Where to land once signed in, and the invitation the sign-in accepts.
 * `returnTo` is the request as sent: the keeper keeps it only when it names
 * a path on its own origin.
 */
export interface SignInQuery {
  readonly returnTo?: string
  readonly invitation?: string
}

function withSignInQuery(path: string, query: SignInQuery): string {
  const params = new URLSearchParams()
  for (const field of ['returnTo', 'invitation'] as const) {
    const value = query[field]
    if (value !== undefined) params.set(SIGN_IN_QUERY_PARAMS[field], value)
  }
  const search = params.toString()
  return search === '' ? path : `${path}?${search}`
}

/**
 * What a sign-in request's query string says — the inverse of the builders
 * below. Takes a reader rather than a URL so the server keeps its framework's
 * own decoding of the string.
 */
export function signInQueryOf(read: (name: string) => string | undefined): SignInQuery {
  const returnTo = read(SIGN_IN_QUERY_PARAMS.returnTo)
  const invitation = read(SIGN_IN_QUERY_PARAMS.invitation)
  return {
    ...(returnTo === undefined ? {} : { returnTo }),
    ...(invitation === undefined ? {} : { invitation }),
  }
}

export function authProvidersUrl(): string {
  return '/auth/providers'
}

export function authSignInUrl(providerId: string, query: SignInQuery = {}): string {
  return withSignInQuery(`/auth/sign-in/${enc(providerId)}`, query)
}

export function authSessionUrl(): string {
  return '/auth/session'
}

export function authSignOutUrl(): string {
  return '/auth/sign-out'
}

export function authReauthenticateUrl(query: Pick<SignInQuery, 'returnTo'> = {}): string {
  return withSignInQuery('/auth/reauthenticate', query)
}

// ---- the web app's server-mode pages the keeper sends a browser to ----
//
// Pages, not routes: the keeper serves the app's shell at them and the web
// app's router mounts them. The keeper links to them (an invitation, a
// refused sign-in), so their paths and keys are fixed here for both sides.

/** ADR-0049 decision 3: the page an invitation link opens. */
export const INVITE_PAGE_PATH = '/invite'
const INVITE_TOKEN_KEY = 'token'

/**
 * The link an invitation travels as, on `origin`. The token rides the
 * fragment, which a browser never sends to a server or puts in a Referer.
 */
export function invitePageUrl(origin: string, token: string): string {
  const url = new URL(INVITE_PAGE_PATH, origin)
  url.hash = new URLSearchParams({ [INVITE_TOKEN_KEY]: token }).toString()
  return url.toString()
}

/** The invitation token an invite page's fragment carries, `#` included or not. */
export function inviteTokenOf(hash: string): string | undefined {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  return params.get(INVITE_TOKEN_KEY) ?? undefined
}

/** The sign-in page, which also explains a refused sign-in. */
export const SIGN_IN_PAGE_PATH = '/sign-in'
const SIGN_IN_REFUSAL_KEY = 'error'

export function signInPageUrl(refusal?: SignInRefusal): string {
  if (refusal === undefined) return SIGN_IN_PAGE_PATH
  return `${SIGN_IN_PAGE_PATH}?${new URLSearchParams({ [SIGN_IN_REFUSAL_KEY]: refusal })}`
}

/**
 * The refusal a sign-in page's query string names, as sent: a value from an
 * older or newer keeper is still a refusal, so the caller judges it against
 * `signInRefusalSchema` rather than this reader dropping it.
 */
export function signInRefusalOf(search: string): string | undefined {
  return new URLSearchParams(search).get(SIGN_IN_REFUSAL_KEY) ?? undefined
}
