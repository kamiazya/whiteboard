/**
 * A daemon for a page test: the routes the index page and the file browser
 * reach, answered from a fixture through `fetch`.
 *
 * ONE route table rather than one per test file, because the copies were
 * re-implementing the daemon's contract by hand — 34 URL matches in one
 * file, seven inline `url.endsWith('/api/workspaces')` branches in another
 * — and nothing checked that what they answered was what the daemon
 * answers. Every default answer here goes through the api-contract schema
 * the client parses with, so a fixture the real client would refuse fails
 * at the fake, not as a page that mysteriously renders nothing. A test's
 * own override (a `Response` returned from an `on*` hook) is the test's
 * answer and is passed through untouched, since refusing a deliberate 500
 * is not the point.
 *
 * Document lists are read PER CALL, and may be a thunk, so a test that
 * reassigns its rows after a create or a delete sees the re-list reflect
 * them without reaching into the fake.
 */

import {
  deleteDocumentResponseSchema,
  listDocumentsResponseSchema,
  listTrashResponseSchema,
  listWorkspacesResponseSchema,
  renameDocumentPathResponseSchema,
  updateDocumentResponseSchema,
  workspaceNamesSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { createDocumentV1ResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { vi } from 'vitest'
import { jsonResponse } from './json-response.js'

export interface FakeDaemonDocumentRow {
  path: string
  updatedAt?: string
  id?: string
  kind?: string
  displayName?: string
}

type Rows = FakeDaemonDocumentRow[]

/**
 * What an `on*` hook may answer: a `Response` (or a pending one) overrides
 * the fake's default; anything else — a recorded push, nothing — leaves it.
 * `unknown` rather than `Response | void`, because a union with `void` stops
 * admitting the bare `created.push(path)` a recording hook is.
 */
type Overriding = unknown
const overrideOf = (value: Overriding): Promise<Response> | undefined =>
  value instanceof Response || value instanceof Promise
    ? Promise.resolve(value as Response | Promise<Response>)
    : undefined

/**
 * The list contract requires id and kind on every row (the daemon always
 * serves both); fixtures may omit them for brevity and get daemon-shaped
 * defaults filled in here.
 */
export function withSummaryDefaults(rows: Rows) {
  return rows.map((row) => ({ id: `id-${row.path}`, kind: 'spatial', ...row }))
}

export interface FakeDaemonRoutes {
  workspaces: Array<{ workspaceId: string; segment?: string; displayName?: string }>
  /** Rows per workspace, or a thunk read on every list. A workspace absent here lists 500. */
  documentsByWorkspace: Record<string, Rows | (() => Rows)>
  namesByWorkspace?: Record<
    string,
    { workspace?: string; documents: Record<string, string>; pinned: string[] } | 'fail'
  >
  /** Return a Response to override the default 201. */
  onCreateDocument?: (workspaceId: string, path: string, kind?: string) => Overriding
  /** Return a Response (or a pending promise of one) to override the default 200 {ok:true}. */
  onDeleteDocument?: (workspaceId: string, path: string) => Overriding
  /** Return a Response to override the default `{ path: to }`. */
  onRenameDocumentPath?: (workspaceId: string, from: string, to: string) => Overriding
  snapshotByDocument?: Record<string, Uint8Array>
  onUpdateDocument?: (workspaceId: string, path: string, bytes: Uint8Array) => void
  onSetDocumentName?: (workspaceId: string, path: string, name: string) => void
  /** The OKF the preview route answers, by document id. */
  okfByDocumentId?: Record<string, { markdown: string; frontmatter: Record<string, unknown> }>
  /** When set, the documents fetch resolves only after this promise settles. */
  delayDocuments?: Promise<void>
  /** Same, for the workspaces list. Consulted per call, so a test can leave
   *  it unset for the initial load and set it before the re-list. */
  delayWorkspaces?: Promise<void>
  /** Override the documents GET. Return undefined to fall through to the
   *  default. Consulted per call, so a test can answer 404 once and then
   *  behave normally — a workspace deleted out from under the page. */
  onListDocuments?: (workspaceId: string) => Response | undefined
  /** Override the workspaces GET. Return undefined to fall through to the
   *  default. Consulted per call, so a test can answer 500 only on the
   *  re-list a switch triggers. */
  onListWorkspaces?: () => Response | undefined
  /** Rows the trash GET answers with; defaults to an empty trash. */
  trashByWorkspace?: Record<string, Array<{ documentId: string; path: string; deletedAt: number }>>
}

const WORKSPACES = /\/api\/workspaces$/
const DOCUMENTS = /\/api\/(?:v1\/)?workspaces\/([^/]+)\/documents$/
// A document path is encoded per SEGMENT (`encodeDocumentPath`), so its
// slashes survive into the URL and the path match has to admit them.
const DOCUMENT = /\/api\/workspaces\/([^/]+)\/documents\/(.+)$/
const DOCUMENT_PATH = /\/api\/workspaces\/([^/]+)\/documents\/(.+)\/path$/
const DOCUMENT_NAME = /\/api\/workspaces\/([^/]+)\/documents\/(.+)\/name$/
const DOCUMENT_OKF = /\/api\/v1\/workspaces\/([^/]+)\/documents\/([^/]+)\/okf$/
const TRASH = /\/api\/workspaces\/([^/]+)\/trash$/
const NAMES = /\/api\/workspaces\/([^/]+)\/names$/
const SNAPSHOT = /\/api\/w\/([^/]+)\/document\/(.+)\/snapshot$/
const UPDATE = /\/api\/w\/([^/]+)\/document\/(.+)\/update$/

const isGet = (init?: RequestInit) => !init || init.method === undefined
const seg = (match: RegExpMatchArray, index: number) => decodeURIComponent(match[index] ?? '')
const parseBody = <T>(init: RequestInit | undefined): T => JSON.parse(String(init?.body)) as T

function listWorkspaces(routes: FakeDaemonRoutes): Promise<Response> {
  const override = routes.onListWorkspaces?.()
  if (override) return Promise.resolve(override)
  const respond = () =>
    jsonResponse(listWorkspacesResponseSchema.parse({ workspaces: routes.workspaces }))
  // Held open so a test can inspect what renders WHILE the re-list is in
  // flight — the window in which a deleted workspace is still selected.
  if (routes.delayWorkspaces) return routes.delayWorkspaces.then(respond)
  return Promise.resolve(respond())
}

function listDocuments(routes: FakeDaemonRoutes, workspaceId: string): Promise<Response> {
  const override = routes.onListDocuments?.(workspaceId)
  if (override) return Promise.resolve(override)
  const rows = routes.documentsByWorkspace[workspaceId]
  if (!rows) return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
  const respond = () =>
    jsonResponse(
      listDocumentsResponseSchema.parse({
        documents: withSummaryDefaults(typeof rows === 'function' ? rows() : rows),
      }),
    )
  if (routes.delayDocuments) return routes.delayDocuments.then(respond)
  return Promise.resolve(respond())
}

function createDocument(
  routes: FakeDaemonRoutes,
  workspaceId: string,
  init?: RequestInit,
): Promise<Response> {
  const body = parseBody<{ path: string; kind?: string }>(init)
  const override = overrideOf(routes.onCreateDocument?.(workspaceId, body.path, body.kind))
  if (override) return override
  return Promise.resolve(
    jsonResponse(
      // The v1 shape, which is what the app's client parses with: the legacy
      // body said only `path`, and a fake answering that reads as a create
      // the client refused.
      createDocumentV1ResponseSchema.parse({
        workspaceId: 'ws-a',
        documentId: '01J9ZC8XK4PQRS7TVWXY0ABCDE',
        path: body.path,
      }),
      201,
    ),
  )
}

function setDocumentName(
  routes: FakeDaemonRoutes,
  workspaceId: string,
  path: string,
  init?: RequestInit,
): Response {
  const body = parseBody<{ name: string }>(init)
  routes.onSetDocumentName?.(workspaceId, path, body.name)
  const names = routes.namesByWorkspace?.[workspaceId]
  const documents = names && names !== 'fail' ? names.documents : {}
  return jsonResponse(
    workspaceNamesSchema.parse({ documents: { ...documents, [path]: body.name }, pinned: [] }),
  )
}

interface Route {
  readonly pattern: RegExp
  /** The method the route answers; absent for GET-shaped reads with no init. */
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  readonly handle: (
    routes: FakeDaemonRoutes,
    match: RegExpMatchArray,
    init: RequestInit | undefined,
  ) => Response | Promise<Response>
}

const notFound = () => jsonResponse({ title: 'Not found' }, 404)

/** The table, in match order: a more specific suffix before the bare document. */
const ROUTES: readonly Route[] = [
  { pattern: WORKSPACES, method: 'GET', handle: (routes) => listWorkspaces(routes) },
  { pattern: DOCUMENTS, method: 'GET', handle: (routes, m) => listDocuments(routes, seg(m, 1)) },
  {
    pattern: DOCUMENTS,
    method: 'POST',
    handle: (routes, m, init) => createDocument(routes, seg(m, 1), init),
  },
  {
    pattern: DOCUMENT_PATH,
    method: 'PUT',
    handle: (routes, m, init) => {
      const to = parseBody<{ path: string }>(init).path
      const override = overrideOf(routes.onRenameDocumentPath?.(seg(m, 1), seg(m, 2), to))
      return override ?? jsonResponse(renameDocumentPathResponseSchema.parse({ path: to }))
    },
  },
  {
    pattern: DOCUMENT_NAME,
    method: 'PUT',
    handle: (routes, m, init) => setDocumentName(routes, seg(m, 1), seg(m, 2), init),
  },
  {
    pattern: DOCUMENT,
    method: 'DELETE',
    handle: (routes, m) =>
      overrideOf(routes.onDeleteDocument?.(seg(m, 1), seg(m, 2))) ??
      jsonResponse(deleteDocumentResponseSchema.parse({ ok: true })),
  },
  {
    pattern: DOCUMENT_OKF,
    method: 'GET',
    handle: (routes, m) => {
      const okf = routes.okfByDocumentId?.[seg(m, 2)]
      return okf ? jsonResponse(okf) : notFound()
    },
  },
  {
    pattern: TRASH,
    method: 'GET',
    handle: (routes, m) =>
      jsonResponse(
        listTrashResponseSchema.parse({ entries: routes.trashByWorkspace?.[seg(m, 1)] ?? [] }),
      ),
  },
  {
    pattern: NAMES,
    handle: (routes, m) => {
      const names = routes.namesByWorkspace?.[seg(m, 1)]
      if (names === 'fail' || !names) return jsonResponse({ message: 'not found' }, 500)
      return jsonResponse(workspaceNamesSchema.parse(names))
    },
  },
  {
    pattern: SNAPSHOT,
    handle: (routes, m) => {
      const bytes = routes.snapshotByDocument?.[seg(m, 2)]
      if (!bytes) return notFound()
      return new Response(bytes as BodyInit, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    },
  },
  {
    pattern: UPDATE,
    method: 'POST',
    handle: (routes, m, init) => {
      routes.onUpdateDocument?.(seg(m, 1), seg(m, 2), new Uint8Array(init?.body as ArrayBuffer))
      return jsonResponse(updateDocumentResponseSchema.parse({ ok: true }))
    },
  },
]

function methodOf(init?: RequestInit): Route['method'] {
  return isGet(init) ? 'GET' : (init?.method as Route['method'])
}

function answer(routes: FakeDaemonRoutes, url: string, init?: RequestInit): Promise<Response> {
  for (const route of ROUTES) {
    const match = url.match(route.pattern)
    if (match === null) continue
    if (route.method !== undefined && route.method !== methodOf(init)) continue
    return Promise.resolve(route.handle(routes, match, init))
  }
  return Promise.resolve(jsonResponse({}, 404))
}

/** Stubs `fetch` with the daemon described by `routes`; answers the mock for assertions. */
export function installFakeDaemonFetch(routes: FakeDaemonRoutes) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    return answer(routes, url, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
