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
  createWorkspaceRequestSchema,
  deleteDocumentResponseSchema,
  listDocumentsResponseSchema,
  listTrashResponseSchema,
  listWorkspacesResponseSchema,
  renameDocumentPathResponseSchema,
  updateDocumentResponseSchema,
  workspaceNamesSchema,
  workspaceSummarySchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import {
  createDocumentV1ResponseSchema,
  type DocumentOkfV1Response,
  documentApiUrl,
  documentNameApiUrl,
  documentOkfApiUrl,
  documentOkfV1ResponseSchema,
  documentPathApiUrl,
  documentRecordApiUrl,
  documentsV1ApiUrl,
  trashApiUrl,
  workspaceDocumentsApiUrl,
  workspaceNamesApiUrl,
  workspacesApiUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { vi } from 'vitest'
import { jsonResponse } from './json-response.js'

interface FakeDaemonDocumentRow {
  path: string
  updatedAt?: string
  documentId?: string
  kind?: string
  name?: string
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
 * The list contract requires documentId and kind on every row (the daemon always
 * serves both); fixtures may omit them for brevity and get daemon-shaped
 * defaults filled in here.
 */
export function withSummaryDefaults(rows: Rows) {
  return rows.map((row) => ({ documentId: `id-${row.path}`, kind: 'spatial', ...row }))
}

export interface FakeDaemonRoutes {
  workspaces: Array<{ workspaceId: string; segment?: string; displayName?: string }>
  /** Rows per workspace, or a thunk read on every list. A workspace absent here lists 500. */
  documentsByWorkspace: Record<string, Rows | (() => Rows)>
  namesByWorkspace?: Record<
    string,
    { workspace?: string; documents: Record<string, string>; pinned: string[] } | 'fail'
  >
  /**
   * Return a Response to override the default 201 `{ workspaceId, displayName }`.
   * The request body is checked against the contract before this is consulted.
   */
  onCreateWorkspace?: (displayName: string) => Overriding
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
  okfByDocumentId?: Record<string, DocumentOkfV1Response>
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

// The patterns are DERIVED from the client's own builders — each is a builder
// called with marker arguments, then opened up where a marker sits — so a
// route a client renames is renamed here with it, instead of leaving a copy of
// the old path answering for a request nothing sends any more.
const WS_MARK = 'WSMARK'
const DOC_MARK = 'DOCMARK'
// A document path keeps its slashes (`encodeDocumentPath` encodes per
// SEGMENT), so its match has to admit them.
const PATH_MARK = 'PATHMARK/MORE'
const regexEscape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const derive = (builtUrl: string) =>
  new RegExp(
    `${regexEscape(builtUrl)
      .replace(WS_MARK, '([^/]+)')
      .replace(PATH_MARK, '(.+)')
      .replace(DOC_MARK, '([^/]+)')}$`,
  )

const WORKSPACES = derive(workspacesApiUrl())
const DOCUMENTS = [
  derive(workspaceDocumentsApiUrl(WS_MARK)),
  derive(documentsV1ApiUrl(WS_MARK)),
] as const
const DOCUMENT = derive(documentRecordApiUrl(WS_MARK, PATH_MARK))
const DOCUMENT_PATH = derive(documentPathApiUrl(WS_MARK, PATH_MARK))
const DOCUMENT_NAME = derive(documentNameApiUrl(WS_MARK, PATH_MARK))
const DOCUMENT_OKF = derive(documentOkfApiUrl(WS_MARK, DOC_MARK))
const TRASH = derive(trashApiUrl(WS_MARK))
const NAMES = derive(workspaceNamesApiUrl(WS_MARK))
const SNAPSHOT = derive(documentApiUrl(WS_MARK, PATH_MARK, 'snapshot'))
const UPDATE = derive(documentApiUrl(WS_MARK, PATH_MARK, 'update'))

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

function createWorkspace(routes: FakeDaemonRoutes, init?: RequestInit): Promise<Response> {
  const body = createWorkspaceRequestSchema.safeParse(
    JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as unknown,
  )
  if (!body.success) return Promise.resolve(jsonResponse({ title: 'displayName is required' }, 400))
  const { displayName } = body.data
  return (
    overrideOf(routes.onCreateWorkspace?.(displayName)) ??
    Promise.resolve(
      jsonResponse(workspaceSummarySchema.parse({ workspaceId: 'ws-created', displayName }), 201),
    )
  )
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
  /** Several when the same handler answers more than one URL family. */
  readonly pattern: RegExp | readonly RegExp[]
  /** The method the route answers; absent for GET-shaped reads with no init. */
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  readonly handle: (
    routes: FakeDaemonRoutes,
    match: RegExpMatchArray,
    init: RequestInit | undefined,
  ) => Response | Promise<Response>
}

const notFound = () => jsonResponse({ title: 'Not found' }, 404)

/**
 * A valid answer for the reads a page makes beside its workspace and document
 * lists, for a hand-written fetch stub that only means to say something about
 * one route. A body this does not describe is one the page's contract refuses.
 */
export function otherReadBody(url: string): Response {
  if (url.endsWith('/trash')) return jsonResponse({ entries: [] })
  if (url.endsWith('/document-tags')) {
    return jsonResponse({ documents: [], contents: [], library: {}, inUse: [] })
  }
  return jsonResponse({ documents: {}, pinned: [] })
}

/** The table, in match order: a more specific suffix before the bare document. */
const ROUTES: readonly Route[] = [
  { pattern: WORKSPACES, method: 'GET', handle: (routes) => listWorkspaces(routes) },
  {
    pattern: WORKSPACES,
    method: 'POST',
    handle: (routes, _match, init) => createWorkspace(routes, init),
  },
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
      return okf ? jsonResponse(documentOkfV1ResponseSchema.parse(okf)) : notFound()
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
    if (route.method !== undefined && route.method !== methodOf(init)) continue
    for (const pattern of [route.pattern].flat()) {
      const match = url.match(pattern)
      if (match !== null) return Promise.resolve(route.handle(routes, match, init))
    }
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
